/** Mount saved connections and real folder selection; only admitted Workspaces enter the native sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { IconEditOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ServerController, type WriteOutcome } from './controller.ts'
import { AuthenticationResources } from './authentication-resources.ts'
import { AuthenticationOverlay } from './AuthenticationOverlay.tsx'
import { EditorDirectories } from './editor-directories.ts'
import { FolderController } from './folder-controller.ts'
import { createEditorStore } from './store.ts'
import { AddServerAction } from './AddServerAction.tsx'
import { ConnectionPicker, type ConnectionPickerInjected } from './ConnectionPicker.tsx'
import { FolderOverlay } from './FolderOverlay.tsx'
import { ServerOverlay } from './ServerOverlay.tsx'
import type { AuthenticationInjected, EditorInjected, FolderInjected, SharedProps } from './types.ts'
import { en, NS, zh } from './locales.ts'

/**
 * Mount generated namespaces before their resource and presentation consumers.
 * @param ctx - Client context with Remote and presentation services.
 * @param contribution - generated SSH namespaces.
 * @returns teardown closing consumers and requests before the namespaces.
 */
export async function mountServers(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const features = ctx.inject(['remote.hemiSshServers', 'remote.hemiSshWorkspaces', 'workspaces', 'contextMenus'], registerServers)
  try { await features.await() } catch (error: unknown) {
    await features.dispose(); await unmount(); throw error
  }
  return async () => { await features.dispose(); await unmount() }
}

function registerServers(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'hemi-ssh-servers-ui: copy')
  ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: 'hemi-ssh.edit' }, IconEditOutlineRegular)
    yield ctx.slots.register({ name: 'contextMenu.icon', key: 'hemi-ssh.remove' }, IconTrashOutlineRegular)
  })
  const closing = new Set<Promise<void>>()
  let menuSequence = 0
  let menuRequest: { occurrence: number; edit: () => void; remove: () => void } | undefined
  ctx.effect(() => () => { menuRequest = undefined }, 'hemi-ssh: captured context-menu commands')
  ctx.effect(() => async () => { await Promise.all([...closing]) }, 'hemi-ssh-servers-ui: request settlement')
  const grants = {
    create: false, update: false, remove: false, browse: false, open: false, workspace: false,
  }
  const endpoints = {
    create: 'hemiSshServers/create', update: 'hemiSshServers/update', remove: 'hemiSshServers/removeServer',
    browse: 'hemiSshWorkspaces/browseSavedFolders',
    open: 'hemiSshWorkspaces/prepareServerFolder', workspace: 'workspace/create',
  } as const
  for (const action of ['create', 'update', 'remove', 'browse', 'open', 'workspace'] as const) {
    ctx.remoteAccess.whenAccess(endpoints[action], () => {
      grants[action] = true
      return () => { grants[action] = false }
    })
  }
  ctx.remoteAccess.whenAccess('hemiSshServers/list', function* () {
    for (const action of ['edit', 'remove'] as const) {
      yield ctx.remoteAccess.whenAccess(action === 'edit' ? 'hemiSshServers/update' : 'hemiSshServers/removeServer', () =>
        ctx.contextMenus.register({
          id: 'hemi-ssh.' + action, target: 'hemi-ssh-connection', order: action === 'edit' ? 100 : 200,
          observe: () => [ctx.locale],
          resolve: (target) => {
            const request = menuRequest
            if (request === undefined || request.occurrence !== target.occurrence) return []
            return [{ id: action, label: ctx.locale.bind(NS)(action === 'edit' ? 'edit' : 'deleteConnection'),
              icon: { key: 'hemi-ssh.' + action }, danger: action === 'remove', separatorBefore: action === 'remove', run: () => {
                if (menuRequest !== request) return
                menuRequest = undefined
                request[action]()
              } }]
          },
        }))
    }
    const authentication = new AuthenticationResources(ctx.remote.hemiSshWorkspaces, ctx.remote)
    const editorDirectories = new EditorDirectories(ctx.remote.hemiSshWorkspaces)
    const controller = new ServerController(ctx.remote.hemiSshServers, action => grants[action])
    const folders = new FolderController(ctx.remote.hemiSshWorkspaces, input => ctx.workspaces.create(input), action =>
      action === 'browse' ? grants.browse : grants.open && grants.workspace)
    yield () => {
      const done = Promise.all([
        controller.dispose(), folders.dispose(), editorDirectories.dispose(), authentication.dispose(),
      ]).then(() => {})
      closing.add(done)
      void done.then(() => { closing.delete(done) })
    }
    let removeAuthentication = ctx.resources.register(authentication.provider())
    const refreshAuthentication = (): void => {
      removeAuthentication()
      removeAuthentication = ctx.resources.register(authentication.provider())
    }
    yield () => { removeAuthentication() }
    yield ctx.resources.register(controller.provider())
    const editorProvider = editorDirectories.provider()
    yield ctx.resources.register({
      protocol: editorProvider.protocol,
      open: (address, context) => { refreshAuthentication(); return editorProvider.open(address, context) },
    })
    yield ctx.resources.register(folders.foldersProvider())
    yield ctx.on('connection/reset', () => { refreshAuthentication(); controller.reset(); folders.reset() })
    yield ctx.slots.inject('shell.overlay', function* () {
      const store = createEditorStore()
      let active = true
      yield () => { active = false; folders.cancel() }
      const settle = (actions: SharedProps['actions'], outcome: WriteOutcome): void => {
        if (!active || outcome.kind === 'withdrawn') return
        if (outcome.kind === 'complete') actions.complete(outcome.notice)
        else actions.fail(outcome.problem, outcome.field)
      }
      yield ctx.slots.register({
        name: 'shell.overlay', id: 'hemi-ssh-servers', locale: NS, store,
        inject: (actions): EditorInjected => ({
          save: (server, input) => {
            if (active) void controller.save(server, input).then((outcome) => { settle(actions, outcome) })
          },
          remove: (server) => { if (active) void controller.remove(server).then((outcome) => { settle(actions, outcome) }) },
          refresh: () => { if (active) void controller.refresh() },
        }),
      }, ServerOverlay)
      yield ctx.slots.register({
        name: 'shell.overlay', id: 'hemi-ssh-folders', locale: NS, store,
        inject: (actions): FolderInjected => ({
          hooks: { directoryRequest: folders.directoryRequest },
          browse: (selection, path) => { if (active) folders.browse(selection, path) },
          closeFolder: () => {
            if (!active) return
            const uncertain = folders.cancel()
            actions.close()
            if (uncertain) actions.inform('openUncertain')
          },
          openFolder: (selection, path) => {
            if (!active) return
            void folders.open(selection, path).then((outcome) => {
              if (!active || outcome.kind === 'withdrawn') return
              if (outcome.kind === 'complete') actions.complete('folderOpened')
              else actions.folderFail(outcome.problem)
            })
          },
        }),
      }, FolderOverlay)
      yield ctx.slots.register({
        name: 'shell.overlay', id: 'hemi-ssh-authentication', locale: NS, store,
        inject: (): AuthenticationInjected => ({
          answerAuthentication: (id, answer, remember) => authentication.answer(id, answer, remember),
        }),
      }, AuthenticationOverlay)
      yield ctx.slots.inject('conversation.hero.workspace.connections', () => ctx.slots.register({
        name: 'conversation.hero.workspace.connections', id: 'hemi-ssh-connections', order: 10, locale: NS, store,
        inject: (actions): ConnectionPickerInjected => ({
          openConnection: (server, onPicked) => {
            if (!active) return
            refreshAuthentication()
            const request = folders.choose(server, (workspaceId) => { if (active) onPicked(workspaceId) }, (uncertain) => {
              if (active) { actions.close(); actions.inform(uncertain ? 'openUncertain' : 'folderUnavailable') }
            })
            actions.open(request)
          },
          menuTarget: (server, dismiss) => {
            const occurrence = ++menuSequence
            // Retain only the latest gesture; target data stays JSON-compatible.
            menuRequest = { occurrence,
              edit: () => { if (active) { dismiss(); folders.cancel(); actions.open({ kind: 'edit', server }) } },
              remove: () => { if (active) { dismiss(); folders.cancel(); actions.open({ kind: 'remove', server }) } },
            }
            return { server, occurrence }
          },
          refresh: () => { if (active) void controller.refresh() },
        }),
      }, ConnectionPicker))
      yield ctx.remoteAccess.whenAccess('hemiSshServers/create', function* () {
        for (const name of ['sidebar.workspaces.add.actions', 'conversation.hero.workspace.add.actions'] as const) {
          yield ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'hemi-ssh-servers', order: 10, locale: NS, store }, AddServerAction))
        }
      })
    })
  })
}
