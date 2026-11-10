/** Import-free Loader fixture capturing its execution instance at activation. */
export const name = 'execution-contribute'
export const inject = ['tools']

export function apply(ctx) {
  const world = ctx.get('executionProbe').world
  const events = ctx.get('executionEvents')
  ctx.effect(() => {
    events.push(`mount:${world}`)
    return () => { events.push(`unmount:${world}`) }
  })
  ctx.effect(() => ctx.tools.register({
    name: 'execution_world', description: `execution in ${world}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(world),
  }))
}
