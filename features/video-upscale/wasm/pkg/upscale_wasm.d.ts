/* tslint:disable */
/* eslint-disable */

/**
 * The model graph and every GPU command are owned by Rust. JavaScript loads
 * this module and supplies VideoFrames; image pixels never enter WASM memory.
 */
export class GpuUpscaler {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `weights` is a pinned A4K or SRVG container. Only model data is copied to WASM.
     */
    static create(canvas: any, weights: Uint8Array, width: number, height: number, precision?: string | null): Promise<GpuUpscaler>;
    /**
     * Safe while a render promise is pending; that promise then rejects.
     */
    destroy(): void;
    /**
     * The promise resolves after GPU completion. A second simultaneous call
     * fails instead of accumulating an unbounded queue of video frames.
     */
    render(source: any): Promise<any>;
    readonly info: any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_gpuupscaler_free: (a: number, b: number) => void;
    readonly gpuupscaler_create: (a: any, b: number, c: number, d: number, e: number, f: number, g: number) => any;
    readonly gpuupscaler_destroy: (a: number) => void;
    readonly gpuupscaler_info: (a: number) => any;
    readonly gpuupscaler_render: (a: number, b: any) => any;
    readonly wasm_bindgen__convert__closures_____invoke__h68b9473c6ead401a: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h6d14216dcbd1d1bf: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h95558aa1823618ea: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
