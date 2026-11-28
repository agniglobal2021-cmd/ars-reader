import { TAG, define } from './tags.js'
// ars-reader: turning pages by the corner
import { PageCurl } from '../../src/curl'
const reduceMotion = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/** Zoom with two fingers goes up to this many times the whole page. */
const MAX_PINCH = 5
/** A zoomed page pulled this far past its edge turns. */
const PAST_EDGE = 90
const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom', 'turn']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => {
        // ars-reader: a turn or a prepared page measured for the old size is no good
        if (this.#turn) this.#abortTurn()
        else if (this.#preload) {
            this.#dropPreload()
            this.#prepare()
        }
        this.#render()
    })
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    // ars-reader: the pages shown, the pages a turn reveals, the turn's overlay
    #sheet
    #underSheet
    #curlBox
    #curl
    #lock = null
    #epoch = 0
    #build = 0
    #preload = null
    #prepareTimer = 0
    #gesture = null
    #turn = null
    #pinch = 1
    #touches = new Map()
    #pinchGesture = null
    #pan = null
    #glide = 0
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
            position: relative;
        }
        .sheet {
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
            height: 100%;
            flex: 0 0 100%;
            position: relative;
            z-index: 1;
        }
        .sheet.under {
            position: absolute;
            inset: 0;
            z-index: 0;
            visibility: hidden;
            pointer-events: none;
        }
        .sheet.under.shown {
            visibility: visible;
        }
        .sheet.under.over {
            z-index: 2;
        }
        .curl {
            position: absolute;
            inset: 0;
            z-index: 3;
        }
        :host([zoomed]) {
            justify-content: flex-start;
            align-items: flex-start;
        }`)
        this.#sheet = document.createElement('div')
        this.#sheet.className = 'sheet'
        this.#underSheet = document.createElement('div')
        this.#underSheet.className = 'sheet under'
        this.#curlBox = document.createElement('div')
        this.#curlBox.className = 'curl'
        this.#root.append(this.#sheet, this.#underSheet, this.#curlBox)
        this.#curl = new PageCurl(this.#curlBox)
        const opts = { passive: false }
        this.addEventListener('touchstart', e => this.#onTouchStart(e), opts)
        this.addEventListener('touchmove', e => this.#onTouchMove(e), opts)
        this.addEventListener('touchend', e => this.#onTouchEnd(e))
        this.addEventListener('touchcancel', e => this.#onTouchCancel(e))

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
            case 'turn':
                this.#dropPreload()
                this.#prepare()
                break
        }
    }
    async #createFrame({ index, src: srcOption }, container = this.#sheet) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        container.append(element)
        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                // ars-reader: a drag on the page pulls it by the corner
                const opts = { passive: false }
                doc.addEventListener('touchstart', e => this.#onTouchStart(e), opts)
                doc.addEventListener('touchmove', e => this.#onTouchMove(e), opts)
                doc.addEventListener('touchend', e => this.#onTouchEnd(e))
                doc.addEventListener('touchcancel', e => this.#onTouchCancel(e))
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    #render(side = this.#side) {
        if (!side) return
        this.#portrait = this.#layout({ left: this.#left, right: this.#right, center: this.#center }, side)
        this.#fitSheet()
    }
    // sizes the frames of a spread for this screen; true when one page shows at a time.
    // `drawn` collects the pages still being drawn (PDF).
    #layout(frames, side, drawn) {
        const center = frames.center
        const left = frames.left ?? {}
        const right = center ?? frames.right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const base = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1
        // ars-reader: zoomed with two fingers
        const scale = base * (typeof this.#zoom === 'number' ? 1 : this.#pinch)

        const transform = frame => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            // ars-reader: a PDF page out of sight is drawn when it shows; with the curl
            // a turn draws its own copy, so the hidden half of a spread needs no picture
            const hidden = portrait && frame !== target
            if (onZoom && !(hidden && this.#curlEnabled)) {
                const painting = onZoom({ doc: frame.iframe.contentDocument, scale })
                if (drawn && painting?.then) drawn.push(painting)
            }
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: 'auto',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
        }
        if (center) {
            transform(center)
        } else {
            transform(left)
            transform(right)
        }
        return portrait
    }
    async #showSpread({ left, right, center, side }) {
        this.#abortTurn()
        this.#sheet.replaceChildren()
        this.#left = null
        this.#right = null
        this.#center = null
        if (center) {
            this.#center = await this.#createFrame(center)
            this.#side = 'center'
            this.#render()
        } else {
            this.#left = await this.#createFrame(left)
            this.#right = await this.#createFrame(right)
            this.#side = this.#left.blank ? 'right'
                : this.#right.blank ? 'left' : side
            this.#render()
        }
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#toTop()
            this.#reportLocation('page')
            this.#prepare()
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#toTop()
            this.#reportLocation('page')
            this.#prepare()
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#render(side)
            return
        }
        this.#index = index
        const spread = this.#spreads[index]
        if (spread.center) {
            const index = this.book.sections.indexOf(spread.center)
            const src = await spread.center?.load?.()
            await this.#showSpread({ center: { index, src } })
        } else {
            const indexL = this.book.sections.indexOf(spread.left)
            const indexR = this.book.sections.indexOf(spread.right)
            const srcL = await spread.left?.load?.()
            const srcR = await spread.right?.load?.()
            const left = { index: indexL, src: srcL }
            const right = { index: indexR, src: srcR }
            await this.#showSpread({ left, right, side })
        }
        this.#toTop()
        this.#reportLocation(reason)
        this.#prepare()
    }
    // ars-reader: a new page while zoomed in begins at its top, as far left as the last one
    #toTop() {
        this.#stopGlide()
        if (this.#pinch > 1) this.scrollTop = 0
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next() {
        if (this.#lock) return
        if (await this.#curlTurn(1)) return
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        if (this.#lock) return
        if (await this.#curlTurn(-1)) return
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }

    // ── ars-reader: turning pages by the corner ──

    get #curlEnabled() {
        return this.getAttribute('turn') === 'curl' && !this.rtl && !reduceMotion.matches
            && (this.#zoom === undefined || this.#zoom === 'fit-page') && this.#pinch === 1
            && (globalThis.visualViewport?.scale ?? 1) <= 1
    }
    // where a turn goes: the other page of this spread (one page on screen) or the next spread
    #target(dir) {
        if (!this.#spreads || this.#index < 0) return null
        if (!this.#center && this.#portrait) {
            if (dir > 0 && this.#side === 'left' && this.#right && !this.#right.blank)
                return { index: this.#index, side: 'right' }
            if (dir < 0 && this.#side === 'right' && this.#left && !this.#left.blank)
                return { index: this.#index, side: 'left' }
        }
        const index = this.#index + dir
        if (index < 0 || index > this.#spreads.length - 1) return null
        return { index, side: dir > 0 ? 'left' : 'right' }
    }
    #sideOf(target, frames) {
        if (frames.center) return 'center'
        return frames.left.blank ? 'right' : frames.right.blank ? 'left' : target.side
    }
    // the target spread, drawn in the sheet under the pages; null when a newer one is wanted
    async #buildUnder(target) {
        const id = ++this.#build
        const spread = this.#spreads[target.index]
        const under = this.#underSheet
        under.replaceChildren()
        const frame = async section => {
            const src = section ? await section.load?.() : undefined
            if (id !== this.#build) return null
            return this.#createFrame({ index: this.book.sections.indexOf(section), src }, under)
        }
        const frames = spread.center
            ? { center: await frame(spread.center) }
            : { left: await frame(spread.left), right: await frame(spread.right) }
        if (id !== this.#build || Object.values(frames).some(f => !f)) return null
        const side = this.#sideOf(target, frames)
        // a PDF page is drawn after its frame loads: the turn waits for the picture
        const drawn = []
        this.#layout(frames, side, drawn)
        await Promise.all(drawn)
        return id === this.#build ? { frames, side } : null
    }
    // the next pages, drawn ahead while the reader reads this one
    #prepare() {
        clearTimeout(this.#prepareTimer)
        if (!this.#curlEnabled || !this.#spreads) return
        this.#prepareTimer = setTimeout(() => {
            if (this.#turn || this.#lock || this.#gesture?.active || !this.#curlEnabled) return
            const target = this.#target(1)
            if (!target || this.#preload?.index === target.index) return
            this.#preload = { index: target.index, ready: this.#buildUnder(target) }
        }, 150)
    }
    #dropPreload() {
        clearTimeout(this.#prepareTimer)
        this.#build++
        this.#preload = null
        this.#underSheet.replaceChildren()
    }
    #box(el) {
        const host = this.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height }
    }
    // the page shown alone in a set of frames, or null when two stand side by side
    #single(frames, side) {
        if (frames.center) return frames.center
        if (this.#portrait) return side === 'left' ? frames.left : frames.right
        return null
    }
    #turnSpec(dir, under, grabY) {
        const look = { paper: this.getAttribute('paper') || '#ffffff', dark: this.getAttribute('paper-dark') === 'true' }
        const host = this.getBoundingClientRect()
        const corner = grabY != null && grabY < host.height * 0.42 ? 'top' : 'bottom'
        const offset = { x: 0, y: 0 }
        const current = { left: this.#left, right: this.#right, center: this.#center }
        const page = this.#single(current, this.#side)
        const back = this.#single(under.frames, under.side)
        if (page || back) {
            if (dir > 0) {
                const el = (page ?? current.right ?? current.left).element
                return { leaf: { rect: this.#box(el), spine: 'left' }, corner, mode: 'lift', top: this.#sheet, offset, look }
            }
            const el = (back ?? under.frames.right ?? under.frames.left).element
            return { leaf: { rect: this.#box(el), spine: 'left' }, corner, mode: 'return', top: this.#underSheet, offset, look }
        }
        const left = this.#box(current.left.element)
        const right = this.#box(current.right.element)
        return dir > 0
            ? { leaf: { rect: right, spine: 'left' }, corner, mode: 'lift', top: this.#sheet, offset, keep: left, look }
            : { leaf: { rect: left, spine: 'right' }, corner, mode: 'lift', top: this.#sheet, offset, keep: right, look }
    }
    async #startTurn(dir, grabY, patience) {
        const target = this.#target(dir)
        if (!target) return null
        const pre = this.#preload
        this.#preload = null
        clearTimeout(this.#prepareTimer)
        const built = pre?.index === target.index ? pre.ready : this.#buildUnder(target)
        const got = patience === null ? await built
            : await Promise.race([built, wait(patience).then(() => null)])
        if (!got) {
            // too slow, or no longer wanted: the page changes the plain way
            this.#dropPreload()
            return null
        }
        const under = { frames: got.frames, side: this.#sideOf(target, got.frames) }
        this.#layout(under.frames, under.side)
        const spec = this.#turnSpec(dir, under, grabY)
        const turn = { dir, target, under, spec }
        this.#turn = turn
        this.#underSheet.classList.add('shown')
        this.#underSheet.classList.toggle('over', spec.mode === 'return')
        this.setAttribute('turning', '')
        this.#curl.begin(spec)
        return turn
    }
    // the turned-to pages become the pages shown, without loading them again
    #finishTurn(turn) {
        const { under, target } = turn
        const was = { index: this.#index, frames: { left: this.#left, right: this.#right, center: this.#center } }
        const old = this.#sheet
        this.#sheet = this.#underSheet
        this.#underSheet = old
        this.#sheet.className = 'sheet'
        this.#underSheet.className = 'sheet under'
        this.#left = under.frames.left ?? null
        this.#right = under.frames.right ?? null
        this.#center = under.frames.center ?? null
        this.#index = target.index
        this.#side = under.side
        this.#render()
        this.#reportLocation('page')
        // back one page: the pages just left are the next ones, already drawn
        const next = this.#target(1)
        if (turn.dir < 0 && next?.index === was.index)
            this.#preload = { index: was.index, ready: Promise.resolve({ frames: was.frames, side: this.#sideOf(next, was.frames) }) }
        else {
            this.#dropPreload()
            this.#prepare()
        }
    }
    #endTurn() {
        this.#turn = null
        this.removeAttribute('turning')
        this.#curl.stop()
        this.#underSheet.className = 'sheet under'
    }
    // the animation is over: the page turned, or it lies back where it was
    #settle(turn, done) {
        if (done) {
            this.#finishTurn(turn)
            this.#endTurn()
            return
        }
        this.#endTurn()
        // a page let go halfway: the next pages stay ready for another try
        if (turn.dir > 0) this.#preload = { index: turn.target.index, ready: Promise.resolve(turn.under) }
        else {
            this.#dropPreload()
            this.#prepare()
        }
    }
    #abortTurn() {
        this.#epoch++
        this.#lock = null
        this.#gesture = null
        if (this.#turn) this.#endTurn()
        this.#dropPreload()
    }
    // a turn by itself (tap, keys); false: no curl, the page changes the plain way
    async #curlTurn(dir) {
        if (!this.#curlEnabled) return false
        const lock = this.#lock = {}
        const epoch = this.#epoch
        try {
            const turn = await this.#startTurn(dir, null, 600)
            // nothing to show in time; or someone went elsewhere meanwhile, and that stands
            if (!turn) return this.#epoch !== epoch
            const done = await this.#curl.play()
            if (this.#turn !== turn) return true
            if (done) await this.#curl.reveal()
            if (this.#turn !== turn) return true
            this.#settle(turn, done)
            return true
        } finally {
            if (this.#lock === lock) this.#lock = null
        }
    }
    // a finger's place over the pages, wherever it landed: around them or in a page's frame
    #pointOf(e, touch) {
        const host = this.getBoundingClientRect()
        const node = e.target
        const doc = node?.nodeType === 9 ? node : node?.ownerDocument
        const frame = doc && doc !== document ? doc.defaultView?.frameElement : null
        if (!frame) return { x: touch.clientX - host.left, y: touch.clientY - host.top, frame: null }
        // a comic's frame is scaled, a page being pinched too: its box on screen over its own size
        const r = frame.getBoundingClientRect()
        const sx = frame.offsetWidth ? r.width / frame.offsetWidth : 1
        const sy = frame.offsetHeight ? r.height / frame.offsetHeight : 1
        return { x: r.left + touch.clientX * sx - host.left, y: r.top + touch.clientY * sy - host.top, frame }
    }
    get #zoomedIn() {
        return this.#pinch > 1 || (globalThis.visualViewport?.scale ?? 1) > 1
            || !(this.#zoom === undefined || this.#zoom === 'fit-page')
    }
    // «only a tap on the edge»: a finger pulling the page does not turn it
    get #dragTurns() {
        return this.getAttribute('drag') !== 'off'
    }
    // every finger this event knows of. A browser may tell a page's frame of the fingers on the
    // other page (Chromium), or only of its own (each frame then tells of its fingers)
    #track(e) {
        const now = performance.now()
        for (const t of e.touches) this.#touches.set(t.identifier, { ...this.#pointOf(e, t), t: now })
    }
    #forget(e) {
        for (const t of e?.changedTouches ?? []) this.#touches.delete(t.identifier)
    }
    #onTouchStart(e) {
        this.#stopGlide()
        // fingers on pages that are gone (the page turned under them) or long still are no more
        const now = performance.now()
        for (const [id, p] of this.#touches)
            if ((p.frame && !p.frame.isConnected) || now - p.t > 8000) this.#touches.delete(id)
        this.#track(e)
        if (this.#touches.size >= 2) {
            if (!this.#pinchGesture) this.#beginPinch()
            return
        }
        if (this.#pinchGesture) return
        const touch = e.changedTouches[0]
        if (!touch) return
        if (this.#pinch > 1) {
            // zoomed in: one finger moves the page about
            this.#gesture = null
            this.#pan = { id: touch.identifier, x: touch.screenX, y: touch.screenY, over: 0, samples: [[e.timeStamp, touch.screenX, touch.screenY]] }
            return
        }
        const at = this.#touches.get(touch.identifier)
        this.#gesture = !this.#lock && !this.#zoomedIn && this.#dragTurns
            ? {
                x: touch.screenX, y: touch.screenY, hostY: at?.y ?? 0,
                // without the curl a swipe still turns the page, when the finger lifts
                curl: this.#curlEnabled,
                samples: [], active: false, dead: false, ready: null, turn: null, lock: null, dx: 0, dy: 0,
            }
            : null
    }
    #onTouchMove(e) {
        this.#track(e)
        // a second finger may first show up moving
        if (!this.#pinchGesture && this.#touches.size >= 2) this.#beginPinch()
        if (this.#pinchGesture) {
            e.preventDefault()
            this.#movePinch()
            return
        }
        if (this.#pan) {
            e.preventDefault()
            this.#movePan(e)
            return
        }
        const g = this.#gesture
        if (!g || g.dead) return
        if (e.touches.length > 1 || this.#zoomedIn) {
            g.dead = true
            if (g.active && g.curl) void this.#endDrag(g, null)
            return
        }
        const touch = e.changedTouches[0]
        const dx = touch.screenX - g.x, dy = touch.screenY - g.y
        g.samples.push([e.timeStamp, dx])
        while (g.samples.length > 2 && e.timeStamp - g.samples[0][0] > 90) g.samples.shift()
        g.dx = dx
        g.dy = dy
        if (!g.active) {
            if (Math.hypot(dx, dy) < 10) return
            // up and down is not a turn: text selection, zoom
            if (Math.abs(dy) > Math.abs(dx) * 1.15) {
                g.dead = true
                return
            }
            if (!g.curl) g.active = true
            else {
                const dir = dx < 0 ? 1 : -1
                if (this.#lock || !this.#target(dir)) {
                    g.dead = true
                    return
                }
                g.active = true
                g.lock = this.#lock = {}
                // the pages under are drawn first; then the corner catches up with the finger
                g.ready = this.#startTurn(dir, g.hostY, null).then(turn => {
                    g.turn = turn
                    if (turn && this.#turn === turn) this.#curl.move(g.dx, g.dy)
                    return turn
                })
            }
        }
        e.preventDefault()
        if (g.turn) this.#curl.move(dx, dy)
    }
    #onTouchEnd(e) {
        this.#forget(e)
        this.#track(e)
        if (this.#pinchGesture) {
            if (this.#touches.size < 2) this.#endPinch()
            return
        }
        if (this.#pan) {
            this.#endPan(e)
            return
        }
        const g = this.#gesture
        this.#gesture = null
        if (!g?.active || g.dead) return
        if (!g.curl) {
            if (Math.abs(g.dx) >= 40) void ((this.rtl ? g.dx > 0 : g.dx < 0) ? this.next() : this.prev())
            return
        }
        const s = g.samples
        const last = s[s.length - 1]
        const v = s.length > 1 && e.timeStamp - last[0] < 100
            ? (last[1] - s[0][1]) / Math.max(1, last[0] - s[0][0]) : 0
        void this.#endDrag(g, v)
    }
    #onTouchCancel(e) {
        this.#forget(e)
        if (this.#pinchGesture && this.#touches.size < 2) this.#endPinch()
        this.#pan = null
        const g = this.#gesture
        this.#gesture = null
        if (g?.active && g.curl && !g.dead) void this.#endDrag(g, null)
    }

    // ── ars-reader: two fingers zoom the page, one moves the zoomed page ──

    // the page frame at a point over the pages, and where in it the point falls (0…1)
    #anchorAt(x, y) {
        const host = this.getBoundingClientRect()
        let best = null
        for (const el of this.#sheet.children) {
            if (el.style.display === 'none') continue
            const r = el.getBoundingClientRect()
            const left = r.left - host.left, top = r.top - host.top
            const inside = x >= left && x <= left + r.width
            if (!best || inside) best = { el, u: (x - left) / (r.width || 1), v: (y - top) / (r.height || 1) }
            if (inside) break
        }
        return best
    }
    #beginPinch() {
        // a page the first finger began to pull lies back down
        const g = this.#gesture
        this.#gesture = null
        if (g?.active && g.curl && !g.dead) void this.#endDrag(g, null)
        this.#pan = null
        if (this.#turn || this.#lock || !this.#spreads) return
        const [a, b] = [...this.#touches.values()]
        const d0 = Math.hypot(a.x - b.x, a.y - b.y)
        if (d0 < 12) return
        const m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        // pages drawn ahead are for the old size
        this.#dropPreload()
        this.#sheet.style.transformOrigin = '0 0'
        this.#pinchGesture = {
            d0, m0, m: m0, z0: this.#pinch, z: this.#pinch,
            sx: this.scrollLeft, sy: this.scrollTop, anchor: this.#anchorAt(m0.x, m0.y),
        }
    }
    #movePinch() {
        const p = this.#pinchGesture
        const pts = [...this.#touches.values()]
        if (pts.length < 2) return
        const [a, b] = pts
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        // a little smaller than the whole page while the fingers are down; it springs back
        const z = Math.min(MAX_PINCH, Math.max(0.7, p.z0 * d / p.d0))
        const k = z / p.z0
        // the point of the page that was under the fingers follows them
        const cx = p.m0.x + p.sx, cy = p.m0.y + p.sy
        this.#sheet.style.transform = `translate(${m.x + p.sx - cx * k}px, ${m.y + p.sy - cy * k}px) scale(${k})`
        p.z = z
        p.m = m
    }
    #endPinch() {
        const p = this.#pinchGesture
        this.#pinchGesture = null
        if (!p) return
        this.#sheet.style.transform = ''
        const z = p.z < 1.06 ? 1 : p.z
        this.#pinch = z
        this.#render()
        if (z === 1) {
            this.scrollLeft = 0
            this.scrollTop = 0
            this.#prepare()
            return
        }
        // the place of the page under the fingers stays under them
        const a = p.anchor
        if (!a?.el.isConnected) return
        const host = this.getBoundingClientRect()
        const r = a.el.getBoundingClientRect()
        this.scrollLeft += r.left - host.left + a.u * r.width - p.m.x
        this.scrollTop += r.top - host.top + a.v * r.height - p.m.y
    }
    #movePan(e) {
        const p = this.#pan
        const touch = [...e.changedTouches].find(t => t.identifier === p.id)
        if (!touch) return
        const dx = touch.screenX - p.x, dy = touch.screenY - p.y
        p.x = touch.screenX
        p.y = touch.screenY
        const before = this.scrollLeft
        this.scrollLeft = before - dx
        this.scrollTop -= dy
        // pulled on past the page's edge: enough of it turns the page
        const moved = this.scrollLeft - before
        if (Math.abs(moved) > 0.5) p.over = 0
        else p.over -= dx
        p.samples.push([e.timeStamp, touch.screenX, touch.screenY])
        while (p.samples.length > 2 && e.timeStamp - p.samples[0][0] > 90) p.samples.shift()
    }
    #endPan(e) {
        const p = this.#pan
        this.#pan = null
        if (this.#dragTurns && Math.abs(p.over) > PAST_EDGE) {
            const forward = this.rtl ? p.over < 0 : p.over > 0
            void (forward ? this.next() : this.prev())
            return
        }
        const s = p.samples
        const [t1, x1, y1] = s[s.length - 1]
        if (s.length < 2 || e.timeStamp - t1 > 80) return
        const [t0, x0, y0] = s[0]
        const dt = Math.max(1, t1 - t0)
        // the page glides on and slows down
        let vx = (x1 - x0) / dt, vy = (y1 - y0) / dt
        let last = performance.now()
        const step = now => {
            const ms = Math.min(48, now - last)
            last = now
            this.scrollLeft -= vx * ms
            this.scrollTop -= vy * ms
            const f = Math.pow(0.95, ms / 16)
            vx *= f
            vy *= f
            this.#glide = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0
        }
        this.#glide = requestAnimationFrame(step)
    }
    #stopGlide() {
        if (this.#glide) cancelAnimationFrame(this.#glide)
        this.#glide = 0
    }
    // the sheet as big as the zoomed pages, so all of them can be scrolled to
    #fitSheet() {
        const sheet = this.#sheet
        if (this.#pinch <= 1) {
            if (this.hasAttribute('zoomed')) {
                this.removeAttribute('zoomed')
                Object.assign(sheet.style, { width: '', height: '', flex: '' })
            }
            return
        }
        let w = 0, h = 0
        for (const el of sheet.children) {
            if (el.style.display === 'none') continue
            w += parseFloat(el.style.width) || 0
            h = Math.max(h, parseFloat(el.style.height) || 0)
        }
        const { width, height } = this.getBoundingClientRect()
        Object.assign(sheet.style, { flex: 'none', width: `${Math.max(w, width)}px`, height: `${Math.max(h, height)}px` })
        this.setAttribute('zoomed', '')
    }
    /** How much the page is zoomed over fitting the screen: 1 is the whole page. */
    get pinch() {
        return this.#pinch
    }
    set pinch(z) {
        this.#stopGlide()
        this.#pinch = Math.min(MAX_PINCH, Math.max(1, Number(z) || 1))
        this.#dropPreload()
        this.#render()
        if (this.#pinch === 1) this.#prepare()
    }
    async #endDrag(g, velocity) {
        try {
            const turn = await g.ready
            if (!turn || this.#turn !== turn) return
            const done = velocity === null ? await this.#curl.cancel() : await this.#curl.release(velocity)
            if (this.#turn !== turn) return
            if (done) await this.#curl.reveal()
            if (this.#turn !== turn) return
            this.#settle(turn, done)
        } finally {
            if (this.#lock === g.lock) this.#lock = null
        }
    }

    getContents() {
        return Array.from(this.#sheet.querySelectorAll('iframe'), frame => ({
            doc: frame.contentDocument,
            // TODO: index, overlayer
        }))
    }
    destroy() {
        this.#observer.unobserve(this)
    }
}

define(TAG.fxl, FixedLayout)
