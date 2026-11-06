// Types for the parts of foliate-js the reader uses. Upstream ships plain JavaScript.

export interface TOCItem {
	label: string;
	href: string;
	subitems?: TOCItem[];
}

export interface Section {
	load(): string | Promise<string>;
	unload?(): void;
	createDocument?(): Document | Promise<Document>;
	size?: number;
	linear?: string;
	cfi?: string;
	id?: unknown;
}

export type LanguageMap = string | Record<string, string>;
export type Contributor = string | { name?: LanguageMap; role?: string | string[] };

export interface BookMetadata {
	title?: LanguageMap;
	subtitle?: LanguageMap;
	author?: Contributor | Contributor[];
	translator?: Contributor | Contributor[];
	editor?: Contributor | Contributor[];
	publisher?: Contributor | Contributor[];
	published?: string;
	language?: string | string[];
	identifier?: string;
	subject?: unknown;
	description?: string;
	[key: string]: unknown;
}

export interface Book {
	sections: Section[];
	dir?: string;
	toc?: TOCItem[];
	metadata?: BookMetadata;
	rendition?: { layout?: string };
	getCover?(): Promise<Blob | null> | Blob | null;
	isExternal?(href: string): boolean;
	transformTarget?: EventTarget;
}

export interface Progress {
	fraction: number;
	section?: { current: number; total: number };
	location?: { current: number; next: number; total: number };
	time?: { section: number; total: number };
	tocItem?: TOCItem;
	pageItem?: TOCItem;
	cfi: string;
	range?: Range;
}

export interface Renderer extends HTMLElement {
	setStyles?(styles: string | [string, string]): void;
	next(): Promise<void>;
	prev(): Promise<void>;
	heads?: HTMLElement[];
	feet?: HTMLElement[];
	readonly atStart?: boolean;
	readonly atEnd?: boolean;
	getContents(): { index: number; doc: Document }[];
	destroy(): void;
}

export class View extends HTMLElement {
	book: Book;
	renderer: Renderer;
	isFixedLayout: boolean;
	lastLocation: Progress | null;
	open(book: Book | File | Blob | string): Promise<void>;
	init(options: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
	close(): void;
	goTo(target: string | number): Promise<unknown>;
	goToFraction(fraction: number): Promise<void>;
	prev(distance?: number): Promise<void>;
	next(distance?: number): Promise<void>;
	goLeft(): Promise<void>;
	goRight(): Promise<void>;
	getSectionFractions(): number[];
}

export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}
export function makeBook(file: File | Blob | string): Promise<Book>;
