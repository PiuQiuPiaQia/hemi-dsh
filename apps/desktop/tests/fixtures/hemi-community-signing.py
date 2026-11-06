"""Permission-free fixed-certificate qualification using only temporary identities and applications."""
import subprocess,tempfile,pathlib,os,json,plistlib,hashlib,secrets,shutil,sys
if sys.platform != 'darwin': raise SystemExit('This qualification requires macOS')
os.chdir(pathlib.Path(__file__).resolve().parents[4])
root=pathlib.Path(tempfile.mkdtemp(prefix='hemi-signature-probe-'));root.chmod(0o700)
def run(label,args,**kwargs):
 result=subprocess.run(args,capture_output=True,timeout=90,**kwargs)
 if result.returncode:
  print(label,'FAILED',result.returncode)
  if label.startswith('sign-test') or label.startswith('squirrel-') or label.startswith('verify-native') or label.startswith('native-self'):print(result.stderr.decode())
  raise RuntimeError(label+' failed; the isolated identity is cleaned in finally')
 return result.stdout+result.stderr
before=run('list-keychains',['/usr/bin/security','list-keychains','-d','user']).decode(); prior=[json.loads(line.strip()) for line in before.splitlines() if line.strip()]
password=secrets.token_urlsafe(32);keychain=root/'test.keychain-db'
try:
 cfg=root/'openssl.cnf';cfg.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=signing\n[dn]\nCN=Hemi Isolated Test\n[signing]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n')
 run('generate-test-certificate',['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-sha256','-days','1','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'cert.pem'),'-config',str(cfg)])
 run('export-test-p12',['/usr/bin/openssl','pkcs12','-export','-inkey',str(root/'key.pem'),'-in',str(root/'cert.pem'),'-out',str(root/'test.p12'),'-passout','stdin','-keypbe','PBE-SHA1-3DES','-certpbe','PBE-SHA1-3DES','-macalg','sha1'],input=(password+'\n').encode())
 run('create-test-keychain',['/usr/bin/security','create-keychain','-p',password,str(keychain)])
 run('unlock-test-keychain',['/usr/bin/security','unlock-keychain','-p',password,str(keychain)])
 run('import-test-identity',['/usr/bin/security','import',str(root/'test.p12'),'-k',str(keychain),'-P',password,'-T','/usr/bin/codesign'])
 run('authorize-test-identity',['/usr/bin/security','set-key-partition-list','-S','apple-tool:,apple:,codesign:','-s','-k',password,str(keychain)])
 run('select-test-keychain',['/usr/bin/security','list-keychains','-d','user','-s',str(keychain),*prior])
 cert=run('read-test-der',['/usr/bin/openssl','x509','-in',str(root/'cert.pem'),'-outform','der']);pin=hashlib.sha1(cert).hexdigest()
 requirement='identifier "ai.hemi.isolated-test" and certificate leaf = H"'+pin+'"'
 (root/'loader.c').write_text('#include <dlfcn.h>\n#include <stdio.h>\nint main(int argc,char**argv){if(argc!=2)return 2;void*p=dlopen(argv[1],RTLD_NOW);if(!p){fputs(dlerror(),stderr);return 1;}dlclose(p);return 0;}\n')
 (root/'library.c').write_text('int hemi_probe(void){return 42;}\n')
 run('compile-test-loader',['/usr/bin/xcrun','clang',str(root/'loader.c'),'-o',str(root/'loader')])
 run('compile-test-library',['/usr/bin/xcrun','clang','-dynamiclib',str(root/'library.c'),'-o',str(root/'probe.dylib')])
 for file in ['loader','probe.dylib']:
  run('sign-negative-control',['/usr/bin/codesign','--force','--sign',pin,'--keychain',str(keychain),'--timestamp=none','--options','runtime',str(root/file)])
 blocked=subprocess.run([str(root/'loader'),str(root/'probe.dylib')],capture_output=True,timeout=20)
 if blocked.returncode==0 or b'Team ID' not in blocked.stderr:raise RuntimeError('The negative control did not exercise library validation')
 print('PASS: self-signed hardened runtime negative control rejects a library without an Apple Team ID')
 run('sign-test-native-runtime',[shutil.which('node'),'apps/desktop/tests/fixtures/hemi-community-runtime.mjs',str(root),pin,str(keychain)])
 run('native-self-signed-library-loading',[str(root/'loader'),str(root/'probe.dylib')])
 print('PASS: production runtime signer permits loading the sealed self-signed library')
 for version in ['1','2']:
  app=root/('Test'+version+'.app');contents=app/'Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
  shutil.copyfile('/usr/bin/true',contents/'MacOS'/'Probe')
  (contents/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'ai.hemi.isolated-test','CFBundleExecutable':'Probe','CFBundlePackageType':'APPL','CFBundleVersion':version}))
  (contents/'Resources/payload.txt').write_text(version)
  run('sign-test-bundle-'+version,['/usr/bin/codesign','--force','--sign',pin,'--keychain',str(keychain),'--timestamp=none','--requirements','=designated => '+requirement,str(app)])
 run('squirrel-equivalent-validation',['/usr/bin/codesign','--verify','--deep','--strict','--all-architectures','-R','='+requirement,str(root/'Test2.app')])
 print('PASS: fixed self-signed certificate validates changed bundles with Squirrel-equivalent nested, strict and all-architecture checks, without adding certificate trust')
 # Exercise the native helper publisher with an isolated executable, without building or launching Swift.
 import importlib.util
 spec=importlib.util.spec_from_file_location('hemi_helper_publisher', 'packages/experimental/cua-macos/native/build_app.py')
 builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
 helper_id=plistlib.loads(pathlib.Path('packages/experimental/cua-macos/native/Info.plist').read_bytes())['CFBundleIdentifier']
 helper_requirement='identifier "'+helper_id+'" and certificate leaf = H"'+pin+'"'
 executable=builder.publish(root/'Test1.app/Contents/MacOS/Probe',root/'helper',pin,pathlib.Path('packages/experimental/cua-macos/native/Info.plist'),keychain=keychain,timestamp='none',requirements='=designated => '+helper_requirement)
 run('verify-native-helper',['/usr/bin/codesign','--verify','--deep','--strict','--all-architectures','-R','='+helper_requirement,str(executable.parents[2])])
 print('PASS: native helper publication retains fixed certificate requirements in its completed receipt')
 if '--native' in sys.argv:
  source=pathlib.Path('apps/desktop/node_modules/electron/dist/Electron.app').resolve()
  appid='ai.hemi.native-probe.'+secrets.token_hex(8)
  native_requirement='identifier "'+appid+'" and certificate leaf = H"'+pin+'"'
  for version,label in [('1.0.0','OldNative'),('1.0.1','NewNative')]:
   app=root/(label+'.app')
   run('clone-electron-'+label,['/bin/cp','-cR',str(source),str(app)])
   plist=app/'Contents/Info.plist';info=plistlib.loads(plist.read_bytes());info.update({'CFBundleIdentifier':appid,'CFBundleName':'Hemi Native Probe','CFBundleVersion':version,'CFBundleShortVersionString':version,'NSAppTransportSecurity':{'NSAllowsArbitraryLoads':True}});plist.write_bytes(plistlib.dumps(info))
   run('clear-test-attributes',['/usr/bin/xattr','-cr',str(app)])
   run('sign-test-native-'+label,[shutil.which('node'),'apps/desktop/tests/fixtures/hemi-community-sign.mjs',str(app),pin,str(keychain),native_requirement])
   run('verify-native-'+label,['/usr/bin/codesign','--verify','--deep','--strict','--all-architectures','-R','='+native_requirement,str(app)])
  run('zip-native-test',['/usr/bin/ditto','-c','-k','--keepParent',str(root/'NewNative.app'),str(root/'update.zip')])
  environment=os.environ.copy();environment['HEMI_ISOLATED_TEST_ROOT']=str(root);environment.pop('ELECTRON_RUN_AS_NODE',None)
  run('native-self-signed-update',[str(root/'OldNative.app/Contents/MacOS/Electron'),str(pathlib.Path('apps/desktop/tests/fixtures/hemi-community-native.mjs').resolve())],env=environment)
  print('PASS: actual Electron Squirrel.Mac accepted a changed application signed by the same self-signed certificate')

finally:
 run('restore-keychain-list',['/usr/bin/security','list-keychains','-d','user','-s',*prior])
 if keychain.exists():run('delete-test-keychain',['/usr/bin/security','delete-keychain',str(keychain)])
 if 'appid' in locals():
  for suffix in ['', '.ShipIt']:
   owned_cache=pathlib.Path.home()/'Library/Caches'/(appid+suffix)
   if owned_cache.is_symlink():owned_cache.unlink()
   elif owned_cache.is_dir():shutil.rmtree(owned_cache)
 shutil.rmtree(root)
