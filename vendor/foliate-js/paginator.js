import { TAG, define } from './tags.js'
// ars-reader: turning pages by the corner
import { PageCurl, isDark } from '../../src/curl'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const reduceMotion = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false }
// a section bigger than this is not copied into the second view (the curl falls back to sliding)
const MIRROR_MAX_SIZE = 3_000_000

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                const background = getBackground(doc)
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        // ars-reader: the frame may already be detached (pane closed) when a resize arrives
        if (!layout || !this.document) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
        'turn',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    // ars-reader: a second view of a section (the page under a turning page), sections shared
    // between the two views by count, and the turn in progress
    #mirrorBox
    #mirror = null
    #mirrorIndex = -1
    #mirrorWant = -1
    #mirrorTask = null
    #mirrorTimer = 0
    #loads = new Map()
    #lastLayout = null
    #curlBox
    #curl
    #turn = null
    #gesture = null
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
            position: relative;
            z-index: 1;
        }
        #mirror {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
            position: relative;
            z-index: 0;
            visibility: hidden;
            pointer-events: none;
        }
        #top.curling #mirror {
            visibility: visible;
        }
        #top.curl-over #mirror {
            z-index: 2;
        }
        #curl {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            position: relative;
            z-index: 3;
        }
        :host([flow="scrolled"]) :is(#mirror, #curl) {
            display: none;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="mirror"></div>
            <div id="container"></div>
            <div id="footer"></div>
            <div id="curl"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')
        this.#mirrorBox = this.#root.getElementById('mirror')
        this.#curlBox = this.#root.getElementById('curl')
        this.#curl = new PageCurl(this.#curlBox)

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('touchcancel', this.#onTouchCancel.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
            doc.addEventListener('touchcancel', this.#onTouchCancel.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'turn':
                this.#scheduleMirror()
                break
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.#scrollToAnchor(this.#anchor),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.#background.style.background = background

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            this.#lastLayout = null
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        this.#lastLayout = { height, width, margin, gap, columnWidth }
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (!this.#view) return
        // a turn in progress would no longer match the pages
        this.#abortTurn()
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        if (this.#mirror && this.#lastLayout) this.#mirror.render(this.#lastLayout)
        this.#scrollToAnchor(this.#anchor)
        this.#scheduleMirror()
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
        // ars-reader: with the curl, a horizontal drag pulls the page by its corner
        this.#gesture = touch && e.touches.length === 1 && this.#curlEnabled && this.#dragTurns && !this.#locked
            ? { x: touch.screenX, y: touch.screenY, hostY: this.#hostY(e, touch), samples: [], active: false, dead: false }
            : null
    }
    // ars-reader: «only a tap on the edge» — a finger pulling the page leaves it where it is
    get #dragTurns() {
        return this.getAttribute('drag') !== 'off'
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (this.#gesture) return this.#dragMove(e, this.#gesture)
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        // ars-reader: pages that curl never slide under the finger, nor do pages a drag does not turn
        if (this.#curlEnabled || !this.#dragTurns) {
            if (e.touches.length === 1) e.preventDefault()
            return
        }
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchEnd(e) {
        this.#touchScrolled = false
        const g = this.#gesture
        this.#gesture = null
        if (g?.active) {
            // the finger's speed over its last moves; a finger that stopped before lifting has none
            const s = g.samples
            const last = s[s.length - 1]
            const v = s.length > 1 && e.timeStamp - last[0] < 100
                ? (last[1] - s[0][1]) / Math.max(1, last[0] - s[0][0]) : 0
            void this.#endDrag(v)
            return
        }
        if (this.scrolled || this.#curlEnabled || !this.#dragTurns) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    #onTouchCancel() {
        const g = this.#gesture
        this.#gesture = null
        if (g?.active) void this.#endDrag(null)
    }

    // ── ars-reader: turning pages by the corner ──

    get #curlEnabled() {
        return this.getAttribute('turn') === 'curl' && !this.scrolled && !this.#vertical
            && !this.#rtl && this.bookDir !== 'rtl' && !reduceMotion.matches
    }
    // the touch's height over the pages, whether it landed in the book's frame or around it
    #hostY(e, touch) {
        const top = this.#top.getBoundingClientRect()
        const node = e.target
        const doc = node?.nodeType === 9 ? node : node?.ownerDocument
        const frame = doc && doc !== document ? doc.defaultView?.frameElement : null
        return (frame ? frame.getBoundingClientRect().top : 0) + touch.clientY - top.top
    }
    #dragMove(e, g) {
        if (g.dead) {
            if (!g.native && e.touches.length === 1) e.preventDefault()
            return
        }
        if (e.touches.length > 1 || globalThis.visualViewport?.scale > 1) {
            // a pinch: the browser zooms, the page falls back
            g.dead = true
            g.native = true
            if (g.active) void this.#endDrag(null)
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const dx = touch.screenX - g.x, dy = touch.screenY - g.y
        g.samples.push([e.timeStamp, dx])
        while (g.samples.length > 2 && e.timeStamp - g.samples[0][0] > 90) g.samples.shift()
        if (!g.active) {
            if (Math.hypot(dx, dy) < 10) return
            // up and down is not a turn
            if (Math.abs(dy) > Math.abs(dx) * 1.15) {
                g.dead = true
                return
            }
            if (!this.#beginDrag(dx < 0 ? 1 : -1, g.hostY)) {
                g.dead = true
                return
            }
            g.active = true
        }
        this.#curl.move(dx, dy)
    }
    #beginDrag(dir, grabY) {
        if (this.#locked) return false
        const target = this.#turnTarget(dir)
        if (!target) return false
        this.#locked = true
        const turn = this.#startTurn(dir, target, grabY)
        void this.#readyMirror(turn)
        return true
    }
    async #endDrag(velocity) {
        const turn = this.#turn
        if (!turn) {
            this.#locked = false
            return
        }
        // null: the touch was taken away (a pinch, the system): the page falls back
        const done = velocity === null ? await this.#curl.cancel() : await this.#curl.release(velocity)
        if (this.#turn === turn) {
            if (done) {
                await this.#curl.reveal()
                await this.#commitTurn(turn)
            }
            this.#endTurn()
        }
        this.#locked = false
    }
    // the page a turn shows: in this section, or the first (last) page of the next (previous)
    #turnTarget(dir) {
        if (!this.#view) return null
        const { page, pages } = this
        const p = page + dir
        if (p >= 1 && p <= pages - 2) return { index: this.#index, page: p, same: true }
        const index = this.#adjacentIndex(dir)
        if (index == null) return null
        return { index, page: dir > 0 ? 1 : null, same: false }
    }
    #turnSpec(dir, grabY) {
        const top = this.#top.getBoundingClientRect()
        const box = this.#container.getBoundingClientRect()
        const W = top.width, H = top.height
        const offset = { x: box.left - top.left, y: box.top - top.top }
        const corner = grabY != null && grabY < H * 0.42 ? 'top' : 'bottom'
        const paper = this.#paper()
        const look = { paper, dark: isDark(paper) }
        if ((this.heads?.length ?? 1) < 2) {
            const leaf = { rect: { x: 0, y: 0, w: W, h: H }, spine: 'left' }
            // forward: this page lifts off the next; back: the previous page comes down over this one
            return dir > 0
                ? { leaf, corner, mode: 'lift', top: this.#container, offset, look }
                : { leaf, corner, mode: 'return', top: this.#mirrorBox, offset, look }
        }
        // two pages: the right one turns over to the left, or the left one back to the right
        const spine = offset.x + box.width / 2
        const left = { x: 0, y: 0, w: spine, h: H }
        const right = { x: spine, y: 0, w: W - spine, h: H }
        return dir > 0
            ? { leaf: { rect: right, spine: 'left' }, corner, mode: 'lift', top: this.#container, offset, keep: left, look }
            : { leaf: { rect: left, spine: 'right' }, corner, mode: 'lift', top: this.#container, offset, keep: right, look }
    }
    #paper() {
        const bg = getComputedStyle(this.#background).backgroundColor
        return bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg) ? bg : '#ffffff'
    }
    #startTurn(dir, target, grabY) {
        const turn = { dir, target: { ...target }, ready: false }
        this.#turn = turn
        const spec = this.#turnSpec(dir, grabY)
        this.#top.classList.toggle('curl-over', spec.mode === 'return')
        // until the second view shows the right page, the paper under the turning page is blank
        this.#mirrorBox.style.opacity = '0'
        this.#top.classList.add('curling')
        this.setAttribute('turning', '')
        this.#curl.begin(spec)
        return turn
    }
    async #readyMirror(turn) {
        const { index } = turn.target
        if (this.#mirrorIndex !== index || !this.#mirror) {
            this.#mirrorWant = index
            await this.#loadMirror(index)
        }
        if (this.#turn !== turn || this.#mirrorIndex !== index || !this.#mirror) return false
        turn.target.page ??= Math.max(1, this.#mirrorPages() - 2)
        this.#mirrorBox.scrollLeft = this.size * turn.target.page
        this.#mirrorBox.style.opacity = ''
        turn.ready = true
        return true
    }
    #mirrorPages() {
        const size = this.size
        return size ? Math.round(this.#mirror.element.getBoundingClientRect().width / size) : 0
    }
    // a turn by itself (tap, keys). False: the page under it is not ready, the turn slides instead
    async #curlTurn(dir) {
        const target = this.#turnTarget(dir)
        if (!target) return false
        if (this.#mirrorIndex !== target.index || !this.#mirror) {
            this.#mirrorWant = target.index
            const ok = await Promise.race([this.#loadMirror(target.index), wait(450).then(() => false)])
            if (!ok || this.#mirrorIndex !== target.index) return false
        }
        const turn = this.#startTurn(dir, target, null)
        if (!(await this.#readyMirror(turn))) {
            if (this.#turn === turn) this.#endTurn()
            return false
        }
        const done = await this.#curl.play()
        if (this.#turn !== turn) return true
        if (done) {
            await this.#curl.reveal()
            await this.#commitTurn(turn)
        }
        this.#endTurn()
        return true
    }
    async #commitTurn(turn) {
        const { dir, target } = turn
        if (target.same) await this.#scrollToPage(target.page, 'page')
        else await this.#goTo({ index: target.index, anchor: dir > 0 ? () => 0 : () => 1 })
    }
    #endTurn() {
        this.#turn = null
        this.removeAttribute('turning')
        this.#curl.stop()
        this.#top.classList.remove('curling', 'curl-over')
        this.#mirrorBox.style.opacity = ''
        this.#scheduleMirror()
    }
    #abortTurn() {
        if (!this.#turn) return
        this.#gesture = null
        this.#endTurn()
        this.#locked = false
    }
    #scheduleMirror() {
        clearTimeout(this.#mirrorTimer)
        this.#mirrorTimer = setTimeout(() => void this.#syncMirror(), 160)
    }
    // the second view holds the section of the next forward turn: this one, or the next at its end
    #mirrorTarget() {
        if (!this.#curlEnabled || !this.#view || !(this.#index >= 0)) return -1
        const { page, pages } = this
        if (pages > 2 && page >= pages - 2) {
            const next = this.#adjacentIndex(1)
            if (next != null) return next
        }
        return this.#index
    }
    async #syncMirror() {
        if (this.#turn) return
        const want = this.#mirrorTarget()
        if (want < 0) return this.#dropMirror()
        if (want === this.#mirrorIndex && this.#mirror) return
        this.#mirrorWant = want
        await this.#loadMirror(want)
    }
    #loadMirror(index) {
        if (this.#mirrorTask?.index === index) return this.#mirrorTask.promise
        const promise = this.#makeMirror(index)
        const task = { index, promise }
        this.#mirrorTask = task
        promise.finally(() => {
            if (this.#mirrorTask === task) this.#mirrorTask = null
        })
        return promise
    }
    async #makeMirror(index) {
        const section = this.sections[index]
        if (!section || (section.size ?? 0) > MIRROR_MAX_SIZE || !this.#lastLayout) return false
        let src
        try {
            src = await this.#acquire(index)
        } catch {
            this.#release(index)
            return false
        }
        const wanted = () => this.#mirrorWant === index && this.#curlEnabled && this.isConnected
            && (!this.#turn || this.#turn.target.index === index)
        if (!src || !wanted()) {
            this.#release(index)
            return false
        }
        const view = new View({ container: this, onExpand: () => {} })
        this.#mirrorBox.append(view.element)
        const host = this.getRootNode()?.host
        let ok = true
        try {
            await view.load(src, doc => {
                // what the book's own view does to a section before it is laid out: language
                // (hyphenation follows it), direction, the reader's styles
                const lang = host?.language
                if (lang) {
                    doc.documentElement.lang ||= lang.canonical ?? ''
                    if (!lang.isCJK) doc.documentElement.dir ||= lang.direction ?? ''
                }
                if (doc.head) {
                    const before = doc.createElement('style')
                    doc.head.prepend(before)
                    const after = doc.createElement('style')
                    doc.head.append(after)
                    this.#styleMap.set(doc, [before, after])
                    this.#applyStyles(doc, this.#styles)
                }
            }, ({ vertical, rtl }) => {
                ok = !vertical && !rtl && vertical === this.#vertical && !!this.#lastLayout
                return ok ? this.#lastLayout : null
            })
        } catch (e) {
            console.warn(e)
            ok = false
        }
        if (!ok || !wanted()) {
            view.destroy()
            view.element.remove()
            this.#release(index)
            return false
        }
        const old = this.#mirror, oldIndex = this.#mirrorIndex
        this.#mirror = view
        this.#mirrorIndex = index
        if (old) {
            old.destroy()
            old.element.remove()
            this.#release(oldIndex)
        }
        return true
    }
    #dropMirror() {
        this.#mirrorWant = -1
        const old = this.#mirror
        if (!old) return
        this.#mirror = null
        old.destroy()
        old.element.remove()
        this.#release(this.#mirrorIndex)
        this.#mirrorIndex = -1
    }

    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const element = this.#container
        const { scrollProp, size } = this
        if (element[scrollProp] === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            element[scrollProp], offset, 300, easeOutQuad,
            x => element[scrollProp] = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            element[scrollProp] = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
        this.#scheduleMirror()
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select}) {
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.#release(oldIndex)
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(this.#acquire(index)
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    this.#release(index)
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    // ars-reader: both views may show the same section; it is loaded once and unloaded when
    // neither shows it any more
    #acquire(index) {
        let entry = this.#loads.get(index)
        if (!entry) {
            entry = { count: 0, src: Promise.resolve().then(() => this.sections[index].load()) }
            this.#loads.set(index, entry)
        }
        entry.count++
        return entry.src
    }
    #release(index) {
        const entry = this.#loads.get(index)
        if (!entry || --entry.count > 0) return
        this.#loads.delete(index)
        this.sections[index]?.unload?.()
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        try {
            // ars-reader: a page turns by its corner when the page under it is ready
            if (distance == null && this.#curlEnabled && await this.#curlTurn(dir)) return
            const prev = dir === -1
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: prev ? () => 1 : () => 0,
            })
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } finally {
            this.#locked = false
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    #applyStyles(doc, styles) {
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles) return false
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles ?? ''
        return true
    }
    setStyles(styles) {
        this.#styles = styles
        const mirror = this.#mirror
        if (mirror && this.#applyStyles(mirror.document, styles))
            mirror.document?.fonts?.ready?.then(() => { if (this.#mirror === mirror) mirror.expand() })
        if (!this.#applyStyles(this.#view?.document, styles)) return

        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() =>
            this.#background.style.background = getBackground(this.#view.document))

        // needed because the resize observer doesn't work in Firefox
        this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#abortTurn()
        clearTimeout(this.#mirrorTimer)
        this.#dropMirror()
        this.#view.destroy()
        this.#view = null
        this.#release(this.#index)
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

define(TAG.paginator, Paginator)
