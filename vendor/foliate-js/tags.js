// Ars Reader patch. Element names carry the plugin version: an updated plugin defines fresh
// elements instead of reusing the classes the previous version registered in this Obsidian session.
// Re-enabling the same version reuses what is already registered instead of throwing.
/* global __ARS_READER_TAG__ */
const suffix = typeof __ARS_READER_TAG__ === 'string' ? __ARS_READER_TAG__ : 'dev'

export const TAG = {
    view: `foliate-view-${suffix}`,
    paginator: `foliate-paginator-${suffix}`,
    fxl: `foliate-fxl-${suffix}`,
}

export const define = (name, cls) => customElements.get(name) ?? customElements.define(name, cls)
