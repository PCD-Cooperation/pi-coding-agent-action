var q=require("url").pathToFileURL(__filename).href;var T=require("node:worker_threads");function $(o){return{clock_time_get(a,i,c){let u=o(),l=new DataView(u.buffer);if(a===0||a===1){let p=BigInt(Date.now())*1000000n;return l.setBigUint64(c,p,!0),0}return 52},fd_write(a,i,c,u){let l=o(),p=new DataView(l.buffer),f=new Uint8Array(l.buffer),h=0;if(a!==1&&a!==2)return 8;for(let _=0;_<c;_++){let g=p.getUint32(i+_*8,!0),P=p.getUint32(i+_*8+4,!0),S=f.slice(g,g+P),w=new TextDecoder().decode(S);a===1?typeof process<"u"&&process.stdout?process.stdout.write(w):console.log(w):typeof process<"u"&&process.stderr?process.stderr.write(w):console.error(w),h+=P}return p.setUint32(u,h,!0),0},fd_close(a){return 52},fd_fdstat_get(a,i){let c=o(),u=new DataView(c.buffer);return a===1||a===2?(u.setUint8(i,2),u.setUint16(i+2,0,!0),u.setBigUint64(i+8,0n,!0),u.setBigUint64(i+16,0n,!0),0):8},fd_seek(a,i,c,u){return 52},random_get(a,i){let c=o(),u=new Uint8Array(c.buffer,a,i);if(typeof crypto<"u"&&crypto.getRandomValues)crypto.getRandomValues(u);else for(let l=0;l<i;l++)u[l]=Math.floor(Math.random()*256);return 0}}}var Q=new TextDecoder;function Z(o,e){let t=new Uint8Array(o.buffer),r=e;for(;t[r]!==0;)r++;if(r===e)return{};let s=Q.decode(t.slice(e,r)),n={};for(let a of s.split(`
`)){let i=a.indexOf("=");i>0&&(n[a.slice(0,i)]=a.slice(i+1))}return n}function ee(o,e){let t=`qjs_ext_${o.name.replace(/-/g,"_")}_versions`,r=o.instance.exports[t];if(typeof r!="function")return;let s=r();if(s!==0)return Z(e,s)}function k(o,e){let t=0,r=0;for(;e.value<o.length;){let s=o[e.value++];if(t|=(s&127)<<r,(s&128)===0)break;r+=7}return t}function te(o){let e=WebAssembly.Module.customSections(o,"dylink.0");if(e.length===0)return null;let t=new Uint8Array(e[0]),r={value:0},s={memorySize:0,memoryAlignment:0,tableSize:0,tableAlignment:0,needed:[]};for(;r.value<t.length;){let n=k(t,r),a=k(t,r),i=r.value+a;if(n===1)s.memorySize=k(t,r),s.memoryAlignment=k(t,r),s.tableSize=k(t,r),s.tableAlignment=k(t,r);else if(n===2){let c=k(t,r);for(let u=0;u<c;u++){let l=k(t,r),p=new TextDecoder().decode(t.slice(r.value,r.value+l));r.value+=l,s.needed.push(p)}}r.value=i}return s}async function I(o,e,t,r,s,n){let a;o.wasm instanceof WebAssembly.Module?a=o.wasm:a=await WebAssembly.compile(o.wasm);let i=te(a);if(!i)throw new Error(`Extension "${o.name}" is not a WASM shared library (missing dylink.0 section)`);let c=e.memory,u=e.__indirect_function_table,l=e.__stack_pointer,p=e.malloc;if(!c)throw new Error("Main module does not export memory");if(!u)throw new Error("Main module does not export __indirect_function_table");if(!p)throw new Error("Main module does not export malloc");let f,h;if(n)f=n.memoryBase,h=n.tableBase;else if(i.memorySize>0){if(f=p(i.memorySize),f===0)throw new Error(`Failed to allocate ${i.memorySize} bytes for extension "${o.name}"`);new Uint8Array(c.buffer,f,i.memorySize).fill(0)}else f=0;n?(h=n.tableBase,h+i.tableSize>u.length&&u.grow(h+i.tableSize-u.length)):(h=u.length,i.tableSize>0&&u.grow(i.tableSize));let _=WebAssembly.Module.imports(a),g={env:{},"GOT.mem":{},"GOT.func":{}};if(_.some(m=>m.module==="wasi_snapshot_preview1")){let m=o.wasi&&s?o.wasi(s):void 0;g.wasi_snapshot_preview1={...t,...m,...r}}let S=new Set(WebAssembly.Module.exports(a).filter(m=>m.kind==="function").map(m=>m.name)),w=new Set;for(let m of _)if(m.module==="env"){if(m.name==="memory"&&m.kind==="memory")g.env.memory=c;else if(m.name==="__indirect_function_table"&&m.kind==="table")g.env.__indirect_function_table=u;else if(m.name==="__memory_base"&&m.kind==="global")g.env.__memory_base=new WebAssembly.Global({value:"i32",mutable:!1},f);else if(m.name==="__table_base"&&m.kind==="global")g.env.__table_base=new WebAssembly.Global({value:"i32",mutable:!1},h);else if(m.name==="__stack_pointer"&&m.kind==="global")g.env.__stack_pointer=l;else if(m.kind==="function"){let x=e[m.name];x&&typeof x=="function"?g.env[m.name]=x:(w.add(m.name),g.env[m.name]=()=>{throw new Error(`Extension "${o.name}" called unresolved symbol: env.${m.name}`)})}else if(m.kind==="global"){let x=e[m.name];x instanceof WebAssembly.Global?g.env[m.name]=x:g.env[m.name]=new WebAssembly.Global({value:"i32",mutable:!0},0)}}else if(m.module==="GOT.mem"&&m.kind==="global")g["GOT.mem"][m.name]=new WebAssembly.Global({value:"i32",mutable:!0},0);else if(m.module==="GOT.func"&&m.kind==="global"){let x=e[m.name];if(x&&typeof x=="function"){let U=u.length;u.grow(1),u.set(U,x),g["GOT.func"][m.name]=new WebAssembly.Global({value:"i32",mutable:!0},U)}else g["GOT.func"][m.name]=new WebAssembly.Global({value:"i32",mutable:!0},0)}let y=[...w].filter(m=>S.has(m)),j={};for(let m of y){let x={target:null};j[m]=x,g.env[m]=(...U)=>{if(!x.target)throw new Error(`Extension "${o.name}" called unresolved symbol during init: env.${m}`);return x.target(...U)}}let E=await WebAssembly.instantiate(a,g),b=E.exports;for(let m of y){let x=b[m];typeof x=="function"&&(j[m].target=x)}typeof b.__wasm_apply_data_relocs=="function"&&b.__wasm_apply_data_relocs(),typeof b.__wasm_call_ctors=="function"&&b.__wasm_call_ctors();let F=o.initFn??`qjs_ext_${o.name.replace(/-/g,"_")}_init`,L={name:o.name,module:a,instance:E,dylink:i,memoryBase:f,tableBase:h,initFn:F};return L.versions=ee(L,c),L}function J(o,e){let t=o.instance.exports[o.initFn];if(typeof t!="function")throw new Error(`Extension "${o.name}" does not export init function "${o.initFn}"`);let r=e.qjs_get_context_ptr(),s=e.qjs_get_runtime_ptr(),n=t(r,s);if(n!==0)throw new Error(`Extension "${o.name}" init function returned error code ${n}`)}async function W(o,e,t,r,s,n){let a=[];for(let i of e){let c=o.find(l=>l.name===i.name);if(!c)throw new Error(`Extension "${i.name}" required by snapshot but not provided`);let u=await I(c,t,r,s,n,{memoryBase:i.memoryBase,tableBase:i.tableBase});u.initFn=i.initFn,a.push(u)}return a}var G="3.6.2";var N=function(o,e,t){if(e!=null){if(typeof e!="object"&&typeof e!="function")throw new TypeError("Object expected.");var r,s;if(t){if(!Symbol.asyncDispose)throw new TypeError("Symbol.asyncDispose is not defined.");r=e[Symbol.asyncDispose]}if(r===void 0){if(!Symbol.dispose)throw new TypeError("Symbol.dispose is not defined.");r=e[Symbol.dispose],t&&(s=r)}if(typeof r!="function")throw new TypeError("Object not disposable.");s&&(r=function(){try{s.call(this)}catch(n){return Promise.reject(n)}}),o.stack.push({value:e,dispose:r,async:t})}else t&&o.stack.push({async:!0});return e},O=(function(o){return function(e){function t(a){e.error=e.hasError?new o(a,e.error,"An error was suppressed during disposal."):a,e.hasError=!0}var r,s=0;function n(){for(;r=e.stack.pop();)try{if(!r.async&&s===1)return s=0,e.stack.push(r),Promise.resolve().then(n);if(r.dispose){var a=r.dispose.call(r.value);if(r.async)return s|=2,Promise.resolve(a).then(n,function(i){return t(i),n()})}else s|=1}catch(i){t(i)}if(s===1)return e.hasError?Promise.reject(e.error):Promise.resolve();if(e.hasError)throw e.error}return n()}})(typeof SuppressedError=="function"?SuppressedError:function(o,e,t){var r=new Error(t);return r.name="SuppressedError",r.error=o,r.suppressed=e,r}),D=512*1024;var B=1363825491,M=2,R=24,H=class o{exports;module;instance;encoder=new TextEncoder;decoder=new TextDecoder;disposed=!1;hostCallbacks=new Map;nextInternalId=1;interruptHandler=null;unhandledRejectionHandler=null;moduleNormalizeHandler=null;moduleLoadHandler=null;timezoneOffsetHandler=null;_global=null;_versions=null;_undefined=null;_null=null;_true=null;_false=null;_ownedHandles=new Set;_activeScope=null;loadedExtensions=[];constructor(e){this.module=e,this.instance=null,this.exports=null}setInstance(e){this.instance=e,this.exports=e.exports}get versions(){if(this.assertNotDisposed(),!this._versions){let e={"quickjs-wasi":G,quickjs:this.readCString(this.exports.qjs_get_quickjs_version())};for(let t of this.loadedExtensions)t.versions&&Object.assign(e,t.versions);this._versions=e}return this._versions}get global(){return this._global||(this._global=new d(this,this.exports.qjs_get_global(),!0)),this._global}get undefined(){return this._undefined||(this._undefined=new d(this,this.exports.qjs_get_undefined(),!0)),this._undefined}get null(){return this._null||(this._null=new d(this,this.exports.qjs_get_null(),!0)),this._null}get true(){return this._true||(this._true=new d(this,this.exports.qjs_get_true(),!0)),this._true}get false(){return this._false||(this._false=new d(this,this.exports.qjs_get_false(),!0)),this._false}static async create(e){let t=o.normalizeOptions(e),r=await o.resolveModule(t.wasm),s=new o(r),{instance:n,wasiBuiltins:a,wasiUserOverrides:i,memoryProxy:c}=await o.instantiate(r,s,t.wasi);if(s.setInstance(n),s.exports._initialize(),(t.intrinsics!==void 0?s.exports.qjs_init2(t.intrinsics):s.exports.qjs_init())!==0)throw new Error("Failed to initialize QuickJS runtime");if(t.extensions){let l=n.exports;for(let p of t.extensions){let f=await I(p,l,a,i,c);s.loadedExtensions.push(f),J(f,l)}}return o.applyLimits(s,t),s}static async restore(e,t){let r=o.normalizeOptions(t),s=await o.resolveModule(r.wasm),n=new o(s),{instance:a,wasiBuiltins:i,wasiUserOverrides:c,memoryProxy:u}=await o.instantiate(s,n,r.wasi);n.setInstance(a);let l=a.exports,p=n.exports.memory,f=p.buffer.byteLength/65536,h=Math.ceil(e.memory.byteLength/65536);if(h>f&&p.grow(h-f),e.extensions.length>0){let g=r.extensions??[];n.loadedExtensions=await W(g,e.extensions,l,i,c,u)}return new Uint8Array(p.buffer).set(e.memory),n.exports.qjs_set_runtime_and_context(e.runtimePtr,e.contextPtr),n.exports.__stack_pointer.value=e.stackPointer,o.applyLimits(n,r),n}static serializeSnapshot(e){let t=new TextEncoder,r=4,s=[],n=[];for(let p of e.extensions){let f=t.encode(p.name),h=t.encode(p.initFn);s.push(f),n.push(h),r+=4+f.length+4+4+4+h.length}let a=R+r+e.memory.byteLength,i=new ArrayBuffer(a),c=new DataView(i),u=new Uint8Array(i);c.setUint32(0,B,!1),c.setUint8(4,M),c.setUint32(8,e.memory.byteLength,!0),c.setUint32(12,e.stackPointer,!0),c.setUint32(16,e.runtimePtr,!0),c.setUint32(20,e.contextPtr,!0);let l=R;c.setUint32(l,e.extensions.length,!0),l+=4;for(let p=0;p<e.extensions.length;p++){let f=e.extensions[p],h=s[p],_=n[p];c.setUint32(l,h.length,!0),l+=4,u.set(h,l),l+=h.length,c.setUint32(l,f.memoryBase,!0),l+=4,c.setUint32(l,f.tableBase,!0),l+=4,c.setUint32(l,_.length,!0),l+=4,u.set(_,l),l+=_.length}return u.set(e.memory,l),u}static deserializeSnapshot(e){if(e.length<R)throw new Error("Invalid snapshot: too small");let t=new DataView(e.buffer,e.byteOffset,e.byteLength),r=t.getUint32(0,!1);if(r!==B)throw new Error(`Invalid snapshot: bad magic (expected 0x${B.toString(16)}, got 0x${r.toString(16)})`);let s=t.getUint8(4);if(s!==M&&s!==1)throw new Error(`Unsupported snapshot version: ${s} (expected ${M})`);let n=t.getUint32(8,!0),a=t.getUint32(12,!0),i=t.getUint32(16,!0),c=t.getUint32(20,!0),u=[],l=R;if(s>=2){let h=t.getUint32(24,!0),_=28,g=new TextDecoder;for(let P=0;P<h;P++){let S=t.getUint32(_,!0);_+=4;let w=g.decode(e.slice(_,_+S));_+=S;let y=t.getUint32(_,!0);_+=4;let j=t.getUint32(_,!0);_+=4;let E=t.getUint32(_,!0);_+=4;let b=g.decode(e.slice(_,_+E));_+=E,u.push({name:w,memoryBase:y,tableBase:j,initFn:b})}l=_}let p=l+n;if(e.length<p)throw new Error(`Invalid snapshot: expected ${p} bytes, got ${e.length}`);return{memory:e.slice(l,l+n),stackPointer:a,runtimePtr:i,contextPtr:c,extensions:u}}static normalizeOptions(e){if(!e)return{wasm:void 0};if(e instanceof WebAssembly.Module)return{wasm:e};if(typeof e=="object"&&("wasm"in e||"wasi"in e||"memoryLimit"in e||"maxStackSize"in e||"interruptHandler"in e||"onUnhandledRejection"in e||"moduleLoader"in e||"intrinsics"in e||"extensions"in e||"timezoneOffset"in e)){let t=e;if(t.maxStackSize!==void 0&&(!Number.isInteger(t.maxStackSize)||t.maxStackSize<0||t.maxStackSize>D))throw new RangeError(`maxStackSize must be an integer between 0 and ${D}`);return t}return{wasm:e}}static applyLimits(e,t){t.memoryLimit!==void 0&&e.exports.qjs_set_memory_limit(t.memoryLimit),t.maxStackSize!==void 0&&e.exports.qjs_set_max_stack_size(t.maxStackSize),t.interruptHandler&&(e.interruptHandler=t.interruptHandler,e.exports.qjs_set_interrupt_handler(1)),t.onUnhandledRejection&&(e.unhandledRejectionHandler=t.onUnhandledRejection,e.exports.qjs_set_promise_rejection_handler(1)),t.moduleLoader&&(e.moduleLoadHandler=t.moduleLoader.load,e.moduleNormalizeHandler=t.moduleLoader.normalize??null,e.exports.qjs_set_module_loader(1));let r=t.timezoneOffset;if(typeof r=="function")e.timezoneOffsetHandler=s=>-r(s)*60;else if(typeof r=="number"){let s=-r*60;e.timezoneOffsetHandler=()=>s}else e.timezoneOffsetHandler=s=>-new Date(s*1e3).getTimezoneOffset()*60}static async resolveModule(e){if(e instanceof WebAssembly.Module)return e;if(e)return WebAssembly.compile(e);throw new TypeError("QuickJS: `wasm` option is required. Provide WASM bytes or a compiled `WebAssembly.Module`. The binary is shipped at `quickjs-wasi/quickjs.wasm` and can be loaded via your environment's preferred mechanism (e.g. `fetch()`, `node:fs/promises`, or a bundler import like Vite's `?url`).")}static async instantiate(e,t,r){let s=null,n=new Proxy({},{get(w,y){return s[y]}}),a=$(()=>s),i=r?r(n):void 0,c={...a,...i},u=(w,y,j,E,b)=>t.handleHostCall(w,y,j,E,b),l=()=>t.interruptHandler&&t.interruptHandler()?1:0,p=(w,y,j)=>{if(!t.unhandledRejectionHandler){t.exports.qjs_free_value(w),t.exports.qjs_free_value(y);return}let E=new d(t,w),b=new d(t,y);try{t.unhandledRejectionHandler(E,b,j!==0)}finally{E.dispose(),b.dispose()}},f=w=>{let y=t.newError(w instanceof Error?w:String(w));t.exports.qjs_throw(y.ptr),y.dispose()},h=(w,y)=>{if(typeof w=="string")return w;let j=w!==null&&typeof w=="object"&&typeof w.then=="function"?"a Promise":`type ${typeof w}`;throw new TypeError(`moduleLoader.${y} must synchronously return a string (got ${j}). Async module loading is not supported. Pre-fetch module sources instead (see the "ES Modules" section of the quickjs-wasi README).`)},_=(w,y)=>{if(!t.moduleNormalizeHandler){let b=t.readCString(y);return t.writeString(b).ptr}let j=t.readCString(w),E=t.readCString(y);try{let b=h(t.moduleNormalizeHandler(j,E),"normalize");return t.writeString(b).ptr}catch(b){return f(b),0}},g=(w,y)=>{if(!t.moduleLoadHandler)return 0;let j=t.readCString(w);try{let E=h(t.moduleLoadHandler(j),"load"),{ptr:b,len:F}=t.writeString(E);return new Uint32Array(t.exports.memory.buffer,y,1)[0]=F,b}catch(E){return f(E),0}},P=(w,y)=>{let j=Number(BigInt(w)<<32n|BigInt(y>>>0));return t.timezoneOffsetHandler?t.timezoneOffsetHandler(j):0},S=await WebAssembly.instantiate(e,{env:{host_call:u,host_interrupt:l,host_promise_rejection:p,host_module_normalize:_,host_module_load:g,host_get_timezone_offset:P},wasi_snapshot_preview1:c});return s=S.exports.memory,{instance:S,wasiBuiltins:a,wasiUserOverrides:i,memoryProxy:n}}handleHostCall(e,t,r,s,n){let a=this.decoder.decode(new Uint8Array(this.exports.memory.buffer,e,t)),i=this.hostCallbacks.get(a);if(!i){let l=this.newError(`Host callback "${a}" is not registered: it was unregistered, its ephemeral function handle was disposed, or it was never re-registered after a snapshot restore.`);return this.exports.qjs_throw(l.ptr),l.dispose(),0}let c=new d(this,r,!1,!0),u=[];if(s>0&&n!==0){let l=new DataView(this.exports.memory.buffer);for(let p=0;p<s;p++){let f=l.getUint32(n+p*4,!0);u.push(new d(this,f,!1,!0))}}try{let l=i.call(c,...u);return this.exports.qjs_dup_value(l.ptr)}catch(l){let p=this.newError(l instanceof Error?l:String(l));return this.exports.qjs_throw(p.ptr),p.dispose(),0}}writeString(e){let t=ne(e),r=this.exports.wasm_malloc(t.length+1);if(r===0)throw new Error("wasm_malloc failed");let s=new Uint8Array(this.exports.memory.buffer);return s.set(t,r),s[r+t.length]=0,{ptr:r,len:t.length}}readCString(e){let t=new Uint8Array(this.exports.memory.buffer),r=e;for(;t[r]!==0;)r++;return this.decoder.decode(t.slice(e,r))}throwIfException(e){if(this.exports.qjs_is_exception(e.ptr)!==0){let t=this.getException();throw e.dispose(),this._ownedHandles.add(t),new v(t)}return e}evalCode(e,t="<eval>",r=0){this.assertNotDisposed();let s=this.writeString(e),n=this.writeString(t),a=this.exports.qjs_eval(s.ptr,s.len,n.ptr,r);return this.exports.wasm_free(s.ptr),this.exports.wasm_free(n.ptr),this.throwIfException(new d(this,a))}compile(e,t="<compile>",r=0,s=0){this.assertNotDisposed();let n=this.writeString(e),a=this.writeString(t),i=this.exports.wasm_malloc(4),c=this.exports.qjs_compile(n.ptr,n.len,a.ptr,r,s,i);if(this.exports.wasm_free(n.ptr),this.exports.wasm_free(a.ptr),c===0){this.exports.wasm_free(i);let p=this.getException();throw new Error(`Compilation error: ${p.toString()}`)}let u=new Uint32Array(this.exports.memory.buffer,i,1)[0];this.exports.wasm_free(i);let l=new Uint8Array(this.exports.memory.buffer,c,u).slice();return this.exports.wasm_free(c),l}evalBytecode(e){this.assertNotDisposed();let t=this.exports.wasm_malloc(e.byteLength);new Uint8Array(this.exports.memory.buffer,t,e.byteLength).set(e);let r=this.exports.qjs_eval_bytecode(t,e.byteLength);return this.exports.wasm_free(t),this.throwIfException(new d(this,r))}executePendingJobs(){this.assertNotDisposed();let e=0;for(;this.exports.qjs_is_job_pending();){if(this.exports.qjs_execute_pending_job()<0){let r=this.getException();throw new Error(`Job execution error: ${r.toString()}`)}e++}return e}runGC(){this.assertNotDisposed(),this.exports.qjs_run_gc()}get gcThreshold(){return this.assertNotDisposed(),this.exports.qjs_get_gc_threshold()}set gcThreshold(e){this.assertNotDisposed(),this.exports.qjs_set_gc_threshold(e)}getMemoryUsage(){this.assertNotDisposed();let e=this.exports.wasm_malloc(208);this.exports.qjs_compute_memory_usage(e);let t=new BigInt64Array(this.exports.memory.buffer,e,26),r={mallocSize:Number(t[0]),mallocLimit:Number(t[1]),memoryUsedSize:Number(t[2]),mallocCount:Number(t[3]),memoryUsedCount:Number(t[4]),atomCount:Number(t[5]),atomSize:Number(t[6]),strCount:Number(t[7]),strSize:Number(t[8]),objCount:Number(t[9]),objSize:Number(t[10]),propCount:Number(t[11]),propSize:Number(t[12]),shapeCount:Number(t[13]),shapeSize:Number(t[14]),jsFuncCount:Number(t[15]),jsFuncSize:Number(t[16]),jsFuncCodeSize:Number(t[17]),jsFuncPc2lineCount:Number(t[18]),jsFuncPc2lineSize:Number(t[19]),cFuncCount:Number(t[20]),arrayCount:Number(t[21]),fastArrayCount:Number(t[22]),fastArrayElements:Number(t[23]),binaryObjectCount:Number(t[24]),binaryObjectSize:Number(t[25])};return this.exports.wasm_free(e),r}getGlobal(){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_global())}newString(e){this.assertNotDisposed();let{ptr:t,len:r}=this.writeString(e),s=this.exports.qjs_new_string(t,r);return this.exports.wasm_free(t),new d(this,s)}newNumber(e){return this.assertNotDisposed(),new d(this,this.exports.qjs_new_number(e))}newBigInt(e){this.assertNotDisposed();let t=Number(e&0xffffffffn),r=Number(e>>32n&0xffffffffn);return new d(this,this.exports.qjs_new_big_int64(t,r))}newObject(){return this.assertNotDisposed(),new d(this,this.exports.qjs_new_object())}newArray(){return this.assertNotDisposed(),new d(this,this.exports.qjs_new_array())}newSymbolFor(e){this.assertNotDisposed();let{ptr:t,len:r}=this.writeString(e),s=new d(this,this.exports.qjs_new_symbol(t,r,1));return this.exports.wasm_free(t),s}newArrayBuffer(e){this.assertNotDisposed();let t=e instanceof ArrayBuffer?new Uint8Array(e):e,r=this.exports.wasm_malloc(t.length);if(r===0)throw new Error("wasm_malloc failed");new Uint8Array(this.exports.memory.buffer).set(t,r);let s=new d(this,this.exports.qjs_new_array_buffer(r,t.length));return this.exports.wasm_free(r),s}newUint8Array(e){this.assertNotDisposed();let t=this.exports.wasm_malloc(e.length);if(t===0)throw new Error("wasm_malloc failed");new Uint8Array(this.exports.memory.buffer).set(e,t);let r=new d(this,this.exports.qjs_new_uint8_array(t,e.length));return this.exports.wasm_free(t),r}getUndefined(){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_undefined())}getNull(){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_null())}getTrue(){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_true())}getFalse(){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_false())}newFunction(e,t){if(this.assertNotDisposed(),this.hostCallbacks.has(e))throw new Error(`Host callback with name "${e}" is already registered`);this.hostCallbacks.set(e,t);let{ptr:r,len:s}=this.writeString(e),n=this.exports.qjs_new_host_function(r,s,0);return this.exports.wasm_free(r),new d(this,n)}withScope(e){this.assertNotDisposed();let t=this._activeScope,r=new Set;this._activeScope=r;let s={escape:n=>(r.delete(n),t?.add(n),n)};try{return e(s)}finally{this._activeScope=t;for(let n of r)n.dispose()}}exportHandle(e){if(this.assertNotDisposed(),e.vm!==this)throw new Error("exportHandle: handle belongs to a different VM");if(e.disposed)throw new Error("exportHandle: handle is disposed");if(e._isBorrowed)throw new Error("exportHandle: cannot export a borrowed handle (host-callback this/argument); its box is freed when the callback returns. dup() it and export the duplicate.");return e.ptr}importHandle(e){if(this.assertNotDisposed(),!Number.isInteger(e)||e<=0||e>=this.exports.memory.buffer.byteLength)throw new Error(`importHandle: invalid token ${e}`);return new d(this,this.exports.qjs_dup_value(e))}newEphemeralFunction(e){this.assertNotDisposed();let t=`__ephemeral:${this.nextInternalId++}`;this.hostCallbacks.set(t,e);let{ptr:r,len:s}=this.writeString(t),n=this.exports.qjs_new_host_function(r,s,0);this.exports.wasm_free(r);let a=new d(this,n);return a._onDispose=()=>{this.hostCallbacks.delete(t)},a}unregisterHostCallback(e){return this.hostCallbacks.delete(e)}newInternalFunction(e,t){this.hostCallbacks.set(e,t);let{ptr:r,len:s}=this.writeString(e),n=this.exports.qjs_new_host_function(r,s,0);return this.exports.wasm_free(r),new d(this,n)}newPromise(){this.assertNotDisposed();let e=this.exports.wasm_malloc(4),t=this.exports.wasm_malloc(4),r=this.exports.qjs_new_promise(e,t),s=new DataView(this.exports.memory.buffer),n=s.getUint32(e,!0),a=s.getUint32(t,!0);this.exports.wasm_free(e),this.exports.wasm_free(t);let i=new d(this,r),c=new d(this,n),u=new d(this,a),l=this;l._ownedHandles.add(c),l._ownedHandles.add(u);let p=null;return{handle:i,get settled(){if(!p){let f;p=new Promise(g=>{f=g});let h=`__settle:${l.nextInternalId++}`,_=l.newInternalFunction(h,()=>(f(),l.hostCallbacks.delete(h),l.undefined));l.promiseThenRaw(i,_,_).dispose(),_.dispose()}return p},resolve(f){l.callFunctionRaw(c,l.undefined,f).dispose(),l._ownedHandles.delete(c),c.dispose()},reject(f){l.callFunctionRaw(u,l.undefined,f).dispose(),l._ownedHandles.delete(u),u.dispose()}}}resolvePromise(e){if(this.assertNotDisposed(),!this.exports.qjs_is_promise(e.ptr))return Promise.resolve({value:e.dup()});let t=this.exports.qjs_promise_state(e.ptr);return t===1?Promise.resolve({value:new d(this,this.exports.qjs_promise_result(e.ptr))}):t===2?Promise.resolve({error:new d(this,this.exports.qjs_promise_result(e.ptr))}):new Promise(r=>{let s=this.nextInternalId++,n=`__onFulfilled:${s}`,a=`__onRejected:${s}`,i=this.newInternalFunction(n,(...u)=>{let l=u[0]?.dup()??this.undefined;return this.hostCallbacks.delete(n),this.hostCallbacks.delete(a),r({value:l}),this.undefined}),c=this.newInternalFunction(a,(...u)=>{let l=u[0]?.dup()??this.undefined;return this.hostCallbacks.delete(n),this.hostCallbacks.delete(a),r({error:l}),this.undefined});this.promiseThenRaw(e,i,c).dispose(),i.dispose(),c.dispose()})}promiseThenRaw(e,t,r){return new d(this,this.exports.qjs_promise_then(e.ptr,t.ptr,r.ptr))}markPromiseHandled(e){this.assertNotDisposed(),this.exports.qjs_promise_mark_as_handled(e.ptr)}callFunction(e,t,...r){return this.throwIfException(this.callFunctionRaw(e,t,...r))}construct(e,...t){this.assertNotDisposed();let r=t.length,s=0;if(r>0){s=this.exports.wasm_malloc(r*4);let a=new DataView(this.exports.memory.buffer);for(let i=0;i<r;i++)a.setUint32(s+i*4,t[i].ptr,!0)}let n=this.exports.qjs_call_constructor(e.ptr,r,s);return s&&this.exports.wasm_free(s),this.throwIfException(new d(this,n))}callFunctionRaw(e,t,...r){this.assertNotDisposed();let s=r.length,n=0;if(s>0){n=this.exports.wasm_malloc(s*4);let i=new DataView(this.exports.memory.buffer);for(let c=0;c<s;c++)i.setUint32(n+c*4,r[c].ptr,!0)}let a=this.exports.qjs_call(e.ptr,t.ptr,s,n);return n&&this.exports.wasm_free(n),new d(this,a)}setProp(e,t,r){if(this.assertNotDisposed(),typeof t=="string"){let{ptr:s}=this.writeString(t);this.exports.qjs_set_prop_string(e.ptr,s,r.ptr),this.exports.wasm_free(s)}else this.exports.qjs_set_prop_value(e.ptr,t.ptr,r.ptr)}defineProp(e,t,r,s){this.assertNotDisposed();let n=0;if(s?.configurable&&(n|=1),s?.writable&&(n|=2),s?.enumerable&&(n|=4),typeof t=="string"){let{ptr:a}=this.writeString(t);this.exports.qjs_define_prop_string(e.ptr,a,r.ptr,n),this.exports.wasm_free(a)}else this.exports.qjs_define_prop_value(e.ptr,t.ptr,r.ptr,n)}getProp(e,t){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_prop_value(e.ptr,t.ptr))}getException(){return this.assertNotDisposed(),new d(this,this.exports.qjs_get_exception())}newError(e){this.assertNotDisposed();let t=this.exports.qjs_new_error(),r=new d(this,t);if(typeof e=="string"){let s=this.newString(e);r.setProp("message",s),s.dispose()}else{let s=this.newString(e.message);if(r.setProp("message",s),s.dispose(),e.name){let n=this.newString(e.name);r.setProp("name",n),n.dispose()}if(e.stack){let n=this.newString(e.stack);r.setProp("stack",n),n.dispose()}}return r}typeof(e){this.assertNotDisposed();let t=this.exports;return t.qjs_is_undefined(e.ptr)?"undefined":t.qjs_is_null(e.ptr)?"object":t.qjs_is_bool(e.ptr)?"boolean":t.qjs_is_number(e.ptr)?"number":t.qjs_is_big_int(e.ptr)?"bigint":t.qjs_is_string(e.ptr)?"string":t.qjs_is_symbol(e.ptr)?"symbol":t.qjs_is_function(e.ptr)?"function":t.qjs_is_object(e.ptr)?"object":"unknown"}dump(e){return this.assertNotDisposed(),this._dump(e,new Map)}_dump(e,t){let r=this.exports;if(!r.qjs_is_undefined(e.ptr)){if(r.qjs_is_null(e.ptr))return null;if(r.qjs_is_bool(e.ptr))return r.qjs_get_bool(e.ptr)!==0;if(r.qjs_is_number(e.ptr))return r.qjs_get_float64(e.ptr);if(r.qjs_is_string(e.ptr))return e.toString();if(r.qjs_is_big_int(e.ptr))return e.toBigInt();if(r.qjs_is_symbol(e.ptr)){let s=r.wasm_malloc(4),n=r.qjs_get_symbol_description(e.ptr,s),i=new DataView(r.memory.buffer).getUint32(s,!0);if(r.wasm_free(s),n===1){let c=new d(this,i),u=c.toString();return c.dispose(),Symbol.for(u)}else if(n===2){new d(this,i).dispose();return}return}if(r.qjs_is_array_buffer(e.ptr))return e.toArrayBuffer();if(r.qjs_is_exception(e.ptr)){let s=this.getException(),n=s.toString();return s.dispose(),new Error(n)}if(!r.qjs_is_function(e.ptr)){if(r.qjs_is_object(e.ptr)){let s=r.qjs_get_value_ptr(e.ptr);if(s){let n=t.get(s);if(n!==void 0)return n}}if(r.qjs_is_object(e.ptr)){let s=r.wasm_malloc(4),n=r.wasm_malloc(4),a=r.wasm_malloc(4),i=r.qjs_get_typed_array_buffer(e.ptr,s,n,a),c=new d(this,i);if(r.qjs_is_exception(c.ptr)===0){let u=new DataView(r.memory.buffer),l=u.getUint32(s,!0),p=u.getUint32(n,!0),f=u.getUint32(a,!0);r.wasm_free(s),r.wasm_free(n),r.wasm_free(a);let h=r.wasm_malloc(4),_=r.qjs_get_array_buffer(c.ptr,h);if(r.wasm_free(h),c.dispose(),_!==0){let g=new Uint8Array(r.memory.buffer,_+l,p).slice();switch(f){case 1:return g;case 2:return new Uint16Array(g.buffer);case 4:return new Uint32Array(g.buffer);case 8:return new Float64Array(g.buffer);default:return g}}}else c.dispose(),r.wasm_free(s),r.wasm_free(n),r.wasm_free(a)}if(r.qjs_is_array(e.ptr)){let s=e.getProp("length"),n=r.qjs_get_float64(s.ptr);s.dispose();let a=[],i=r.qjs_get_value_ptr(e.ptr);i&&t.set(i,a);for(let c=0;c<n;c++){let u=r.qjs_get_prop_uint32(e.ptr,c),l=new d(this,u);a.push(this._dump(l,t)),l.dispose()}return a}if(r.qjs_is_error(e.ptr)){let s=e.getProp("name"),n=e.getProp("message"),a=e.getProp("stack"),i=s.isUndefined?"Error":s.toString(),c=n.isUndefined?"":n.toString(),u=a.isUndefined?void 0:a.toString();s.dispose(),n.dispose(),a.dispose();let l=new Error(c);return l.name=i,u!==void 0&&(l.stack=u),l}if(r.qjs_is_object(e.ptr)){let s=r.qjs_get_own_property_names(e.ptr),n=new d(this,s);if(r.qjs_is_exception(n.ptr)!==0)return n.dispose(),{};let a=n.getProp("length"),i=r.qjs_get_float64(a.ptr);a.dispose();let c={},u=r.qjs_get_value_ptr(e.ptr);u&&t.set(u,c);for(let l=0;l<i;l++){let p=r.qjs_get_prop_uint32(n.ptr,l),f=new d(this,p),h=f.toString();f.dispose();let _=e.getProp(h);c[h]=this._dump(_,t),_.dispose()}return n.dispose(),c}}}}hostToHandle(e){if(this.assertNotDisposed(),e===void 0)return this.undefined;if(e===null)return this.null;if(e===!0)return this.true;if(e===!1)return this.false;if(typeof e=="number")return this.newNumber(e);if(typeof e=="string")return this.newString(e);if(typeof e=="bigint")return this.newBigInt(e);if(typeof e=="symbol"){let t=Symbol.keyFor(e);if(t!==void 0)return this.newSymbolFor(t);throw new Error("Cannot convert local symbol to QuickJS handle. Use Symbol.for() for cross-boundary symbols.")}if(e instanceof Promise){let t=this.newPromise();return e.then(r=>{t.resolve(this.hostToHandle(r)),this.executePendingJobs()},r=>{t.reject(this.hostToHandle(r)),this.executePendingJobs()}),t.handle}if(e instanceof Error)return this.newError(e);if(e instanceof ArrayBuffer)return this.newArrayBuffer(e);if(e instanceof Uint8Array)return this.newUint8Array(e);if(ArrayBuffer.isView(e))return this.newArrayBuffer(new Uint8Array(e.buffer,e.byteOffset,e.byteLength));if(Array.isArray(e)){let t=this.newArray();for(let r=0;r<e.length;r++){let s=this.hostToHandle(e[r]);this.exports.qjs_set_prop_uint32(t.ptr,r,s.ptr),s.dispose()}return t}if(typeof e=="object"&&e!==null){let t=this.newObject();for(let[r,s]of Object.entries(e)){let n=this.hostToHandle(s);t.setProp(r,n),n.dispose()}return t}return this.undefined}snapshot(){return this.assertNotDisposed(),{memory:new Uint8Array(this.exports.memory.buffer).slice(),stackPointer:this.exports.__stack_pointer.value,runtimePtr:this.exports.qjs_get_runtime_ptr(),contextPtr:this.exports.qjs_get_context_ptr(),extensions:this.loadedExtensions.map(e=>({name:e.name,memoryBase:e.memoryBase,tableBase:e.tableBase,initFn:e.initFn}))}}registerHostCallback(e,t){this.hostCallbacks.set(e,t)}dispose(){this.disposed||(this.disposed=!0,this._global=null,this._undefined=null,this._null=null,this._true=null,this._false=null,this._ownedHandles.clear(),this.hostCallbacks.clear(),this._activeScope=null,this.exports=null,this.instance=null,this.module=null)}[Symbol.dispose](){this.dispose()}assertNotDisposed(){if(this.disposed)throw new Error("QuickJS instance has been disposed")}_getExports(){return this.exports}_getMemory(){return this.exports.memory}_writeString(e){return this.writeString(e)}_readCString(e){return this.readCString(e)}};function C(o){return o.includes("\0")||V.test(o)}var re=new TextDecoder,se=new TextEncoder,V=/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;function ne(o){if(!V.test(o))return se.encode(o);let e=[];for(let t=0;t<o.length;t++){let r=o.charCodeAt(t);if(r<128)e.push(r);else if(r<2048)e.push(192|r>>6,128|r&63);else if(r>=55296&&r<=56319&&t+1<o.length){let s=o.charCodeAt(t+1);if(s>=56320&&s<=57343){let n=65536+(r-55296<<10)+(s-56320);e.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|n&63),t++;continue}e.push(224|r>>12,128|r>>6&63,128|r&63)}else e.push(224|r>>12,128|r>>6&63,128|r&63)}return new Uint8Array(e)}function oe(o){let e=!1;for(let s=0;s<o.length-1;s++)if(o[s]===237&&o[s+1]>=160&&o[s+1]<=191){e=!0;break}if(!e)return re.decode(o);let t="",r=0;for(;r<o.length;){let s=o[r];if(s<128)t+=String.fromCharCode(s),r+=1;else if(s<224)t+=String.fromCharCode((s&31)<<6|o[r+1]&63),r+=2;else if(s<240)t+=String.fromCharCode((s&15)<<12|(o[r+1]&63)<<6|o[r+2]&63),r+=3;else{let n=(s&7)<<18|(o[r+1]&63)<<12|(o[r+2]&63)<<6|o[r+3]&63;t+=String.fromCodePoint(n),r+=4}}return t}var v=class extends Error{handle;#e;#t;#r;constructor(e){let t={stack:[],error:void 0,hasError:!1};try{super(),this.handle=e,delete this.stack;let r=N(t,e.getProp("message"),!1);this.#e=e.getProp("name").consume(s=>s.isUndefined?"Error":s.toString()),this.#t=r.isUndefined?e.toString():r.toString(),this.#r=e.getProp("stack").consume(s=>s.isUndefined?void 0:s.toString())}catch(r){t.error=r,t.hasError=!0}finally{O(t)}}get name(){return this.#e}set name(e){this.#e=e}get message(){return this.#t}set message(e){this.#t=e}get stack(){return this.#r}set stack(e){this.#r=e}dispose(){this.handle.dispose()}[Symbol.dispose](){this.handle.dispose()}},d=class o{vm;ptr;disposed_=!1;singleton;borrowed;_onDispose;constructor(e,t,r=!1,s=!1){this.vm=e,this.ptr=t,this.singleton=r,this.borrowed=s,!r&&!s&&e._activeScope?.add(this)}get _isBorrowed(){return this.borrowed}get disposed(){return this.disposed_}get isUndefined(){return this.vm._getExports().qjs_is_undefined(this.ptr)!==0}get isNull(){return this.vm._getExports().qjs_is_null(this.ptr)!==0}get isBool(){return this.vm._getExports().qjs_is_bool(this.ptr)!==0}get isNumber(){return this.vm._getExports().qjs_is_number(this.ptr)!==0}get isString(){return this.vm._getExports().qjs_is_string(this.ptr)!==0}get isSymbol(){return this.vm._getExports().qjs_is_symbol(this.ptr)!==0}get isBigInt(){return this.vm._getExports().qjs_is_big_int(this.ptr)!==0}get isObject(){return this.vm._getExports().qjs_is_object(this.ptr)!==0}get isArray(){return this.vm._getExports().qjs_is_array(this.ptr)!==0}get isFunction(){return this.vm._getExports().qjs_is_function(this.ptr)!==0}get isError(){return this.vm._getExports().qjs_is_error(this.ptr)!==0}get isPromise(){return this.vm._getExports().qjs_is_promise(this.ptr)!==0}get isArrayBuffer(){return this.vm._getExports().qjs_is_array_buffer(this.ptr)!==0}get isProxy(){return this.vm._getExports().qjs_is_proxy(this.ptr)!==0}get isMap(){return this.vm._getExports().qjs_is_map(this.ptr)!==0}get isSet(){return this.vm._getExports().qjs_is_set(this.ptr)!==0}get isDate(){return this.vm._getExports().qjs_is_date(this.ptr)!==0}get isRegExp(){return this.vm._getExports().qjs_is_regexp(this.ptr)!==0}get isWeakRef(){return this.vm._getExports().qjs_is_weak_ref(this.ptr)!==0}get isWeakMap(){return this.vm._getExports().qjs_is_weak_map(this.ptr)!==0}get isWeakSet(){return this.vm._getExports().qjs_is_weak_set(this.ptr)!==0}get isDataView(){return this.vm._getExports().qjs_is_data_view(this.ptr)!==0}get identity(){return this.vm._getExports().qjs_get_value_ptr(this.ptr)}toBoolean(){return this.vm._getExports().qjs_get_bool(this.ptr)!==0}get classId(){return this.vm._getExports().qjs_get_class_id(this.ptr)}get className(){let e=new o(this.vm,this.vm._getExports().qjs_get_class_name(this.ptr));if(this.vm._getExports().qjs_is_exception(e.ptr)!==0)throw e.dispose(),new v(this.vm.getException());try{return e.isUndefined?void 0:e.toString()}finally{e.dispose()}}get promiseState(){return this.vm._getExports().qjs_promise_state(this.ptr)}get typeof(){return this.vm.typeof(this)}get length(){let e=this.getProp("length"),t=e.toNumber();return e.dispose(),t}get constructorName(){let e=this.getProp("constructor");if(e.isUndefined||e.isNull){e.dispose();return}let t=e.getProp("name");if(e.dispose(),t.isUndefined||t.isNull){t.dispose();return}let r=t.toString();return t.dispose(),r}keys(){let e=this.vm._getExports(),t=e.qjs_get_own_property_names(this.ptr),r=new o(this.vm,t);if(e.qjs_is_exception(r.ptr)!==0)return r.dispose(),[];let s=r.getProp("length"),n=e.qjs_get_float64(s.ptr);s.dispose();let a=[];for(let i=0;i<n;i++){let c=e.qjs_get_prop_uint32(r.ptr,i),u=new o(this.vm,c);a.push(u.toString()),u.dispose()}return r.dispose(),a}getOwnPropertyNames(){let e=this.vm._getExports(),t=e.qjs_get_own_property_names_all(this.ptr),r=new o(this.vm,t);if(e.qjs_is_exception(r.ptr)!==0)return r.dispose(),[];let s=r.getProp("length"),n=e.qjs_get_float64(s.ptr);s.dispose();let a=[];for(let i=0;i<n;i++){let c=e.qjs_get_prop_uint32(r.ptr,i),u=new o(this.vm,c);a.push(u.toString()),u.dispose()}return r.dispose(),a}getOwnPropertyKeys(){let e=this.vm._getExports(),t=e.qjs_get_own_property_keys(this.ptr),r=new o(this.vm,t);if(e.qjs_is_exception(r.ptr)!==0)return r.dispose(),[];let s=r.getProp("length"),n=e.qjs_get_float64(s.ptr);s.dispose();let a=[];for(let i=0;i<n;i++){let c=e.qjs_get_prop_uint32(r.ptr,i),u=new o(this.vm,c);u.isSymbol?a.push(u):(a.push(u.toString()),u.dispose())}return r.dispose(),a}getOwnPropertyDescriptor(e){let t={stack:[],error:void 0,hasError:!1};try{let r=this.vm._getExports(),s,n;typeof e=="string"?(s=this.vm.newString(e),n=s.ptr):n=e.ptr;let a=r.qjs_get_own_property_descriptor(this.ptr,n);if(s?.dispose(),a===0)return;let i=N(t,new o(this.vm,a),!1);if(r.qjs_is_exception(i.ptr)!==0)throw new v(this.vm.getException());let c=i.getProp("enumerable").consume(l=>r.qjs_get_bool(l.ptr)!==0),u=i.getProp("configurable").consume(l=>r.qjs_get_bool(l.ptr)!==0);return i.hasOwnProperty("value")?{value:i.getProp("value"),writable:i.getProp("writable").consume(l=>r.qjs_get_bool(l.ptr)!==0),enumerable:c,configurable:u}:{get:i.getProp("get"),set:i.getProp("set"),enumerable:c,configurable:u}}catch(r){t.error=r,t.hasError=!0}finally{O(t)}}hasOwnProperty(e){if(C(e)){let s={stack:[],error:void 0,hasError:!1};try{let n=N(s,this.vm.newString(e),!1);return this.vm._getExports().qjs_has_own_property_value(this.ptr,n.ptr)===1}catch(n){s.error=n,s.hasError=!0}finally{O(s)}}let{ptr:t}=this.vm._writeString(e),r=this.vm._getExports().qjs_has_own_property(this.ptr,t);return this.vm._getExports().wasm_free(t),r===1}propertyIsEnumerable(e){if(C(e)){let s={stack:[],error:void 0,hasError:!1};try{let n=N(s,this.vm.newString(e),!1);return this.vm._getExports().qjs_property_is_enumerable_value(this.ptr,n.ptr)===1}catch(n){s.error=n,s.hasError=!0}finally{O(s)}}let{ptr:t}=this.vm._writeString(e),r=this.vm._getExports().qjs_property_is_enumerable(this.ptr,t);return this.vm._getExports().wasm_free(t),r===1}getPrototypeOf(){let e=this.vm._getExports().qjs_get_prototype_of(this.ptr);return new o(this.vm,e)}getProxyTarget(){let e=this.vm._getExports().qjs_get_proxy_target(this.ptr),t=new o(this.vm,e);if(this.vm._getExports().qjs_is_exception(t.ptr)!==0)throw t.dispose(),new v(this.vm.getException());return t}getProxyHandler(){let e=this.vm._getExports().qjs_get_proxy_handler(this.ptr),t=new o(this.vm,e);if(this.vm._getExports().qjs_is_exception(t.ptr)!==0)throw t.dispose(),new v(this.vm.getException());return t}getProp(e){if(C(e)){let s={stack:[],error:void 0,hasError:!1};try{let n=N(s,this.vm.newString(e),!1);return this.vm.getProp(this,n)}catch(n){s.error=n,s.hasError=!0}finally{O(s)}}let{ptr:t}=this.vm._writeString(e),r=this.vm._getExports().qjs_get_prop_string(this.ptr,t);return this.vm._getExports().wasm_free(t),new o(this.vm,r)}setProp(e,t){if(C(e)){let s={stack:[],error:void 0,hasError:!1};try{let n=N(s,this.vm.newString(e),!1);this.vm.setProp(this,n,t);return}catch(n){s.error=n,s.hasError=!0}finally{O(s)}}let{ptr:r}=this.vm._writeString(e);this.vm._getExports().qjs_set_prop_string(this.ptr,r,t.ptr),this.vm._getExports().wasm_free(r)}defineProp(e,t,r){let s=0;if(r?.configurable&&(s|=1),r?.writable&&(s|=2),r?.enumerable&&(s|=4),typeof e=="string"){if(C(e)){let a={stack:[],error:void 0,hasError:!1};try{let i=N(a,this.vm.newString(e),!1);this.vm._getExports().qjs_define_prop_value(this.ptr,i.ptr,t.ptr,s);return}catch(i){a.error=i,a.hasError=!0}finally{O(a)}}let{ptr:n}=this.vm._writeString(e);this.vm._getExports().qjs_define_prop_string(this.ptr,n,t.ptr,s),this.vm._getExports().wasm_free(n)}else this.vm._getExports().qjs_define_prop_value(this.ptr,e.ptr,t.ptr,s)}toNumber(){return this.vm._getExports().qjs_get_float64(this.ptr)}toBigInt(){let e=this.vm._getExports(),t=e.wasm_malloc(4),r=e.wasm_malloc(4);if(e.qjs_get_big_int64(this.ptr,t,r)!==0)throw e.wasm_free(t),e.wasm_free(r),new Error("Failed to convert value to BigInt");let n=new DataView(e.memory.buffer),a=n.getUint32(t,!0),i=n.getInt32(r,!0);return e.wasm_free(t),e.wasm_free(r),BigInt(i)<<32n|BigInt(a)}toArrayBuffer(){let e=this.vm._getExports(),t=e.wasm_malloc(4);if(e.qjs_is_array_buffer(this.ptr)){let h=e.qjs_get_array_buffer(this.ptr,t);if(h===0)throw e.wasm_free(t),new Error("Failed to get ArrayBuffer data");let g=new DataView(e.memory.buffer).getUint32(t,!0);return e.wasm_free(t),new Uint8Array(e.memory.buffer,h,g).slice().buffer}e.wasm_free(t);let r=e.wasm_malloc(4),s=e.wasm_malloc(4),n=e.wasm_malloc(4),a=e.qjs_get_typed_array_buffer(this.ptr,r,s,n),i=new o(this.vm,a);if(this.vm._getExports().qjs_is_exception(i.ptr)!==0)throw i.dispose(),e.wasm_free(r),e.wasm_free(s),e.wasm_free(n),new Error("Value is not an ArrayBuffer or typed array");let c=new DataView(e.memory.buffer),u=c.getUint32(r,!0),l=c.getUint32(s,!0);e.wasm_free(r),e.wasm_free(s),e.wasm_free(n);let p=e.wasm_malloc(4),f=e.qjs_get_array_buffer(i.ptr,p);if(e.wasm_free(p),i.dispose(),f===0)throw new Error("Failed to get ArrayBuffer data from typed array");return new Uint8Array(e.memory.buffer,f+u,l).slice().buffer}toUint8Array(){return new Uint8Array(this.toArrayBuffer())}toString(){let e=this.vm._getExports(),t=e.wasm_malloc(4);if(t===0)throw new Error("wasm_malloc failed");try{let r=e.qjs_get_string_len(this.ptr,t);if(r===0)return"<null>";let s=new DataView(e.memory.buffer).getUint32(t,!0),n=new Uint8Array(e.memory.buffer,r,s),a=oe(n);return e.qjs_free_cstring(r),a}finally{e.wasm_free(t)}}consume(e){try{return e(this)}finally{this.dispose()}}dup(){return new o(this.vm,this.vm._getExports().qjs_dup_value(this.ptr))}dispose(){if(!(this.singleton||this.borrowed)&&!this.disposed_){this.disposed_=!0,this._onDispose?.(),this._onDispose=void 0;let e=this.vm._getExports();e&&e.qjs_free_value(this.ptr)}}[Symbol.dispose](){this.dispose()}};var z="image expects a non-empty image URL string, an object with image_url, or a raw MCP image block",X=`(function (bridge, toolsJson, globalsJson, storeJson) {
	"use strict";
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const promiseThen = Promise.prototype.then;
	const ErrorCtor = Error;
	const TypeErrorCtor = TypeError;
	const pending = new Map();
	let nextId = 1;
	let finished = false;
	// Thrown by exit() to unwind the script after it already reported success.
	const EXIT = Object.freeze({});

	function done(ok, payload, writes) {
		if (finished) return;
		finished = true;
		bridge("done", ok, payload, writes);
	}

	function serialize(value) {
		return value === undefined ? undefined : stringify(value);
	}

	// QuickJS stacks list frames only. Prefix "Name: message" like V8 so the
	// text reads the same as a Node error, and drop this prelude's frames.
	function errorText(error) {
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		const frames =
			typeof error.stack === "string"
				? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
				: [];
		return [head, ...frames].join("\\n");
	}

	function format(value) {
		if (typeof value === "string") return value;
		if (value instanceof ErrorCtor) return errorText(value);
		try {
			const json = stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	}

	function describeError(error) {
		if (error instanceof ErrorCtor) {
			return stringify({ name: error.name, message: error.message, stack: errorText(error) });
		}
		return stringify({ message: format(error) });
	}

	function caller(kind, name, spread) {
		return (...args) =>
			new Promise((resolve, reject) => {
				let json;
				try {
					json = serialize(spread ? args : args[0]);
				} catch (error) {
					reject(error);
					return;
				}
				const id = nextId++;
				pending.set(id, { resolve, reject });
				bridge(kind, id, name, json);
			});
	}

	const tools = Object.create(null);
	const allTools = [];
	for (const { name, jsName, description } of parse(toolsJson)) {
		const fn = caller("call", name);
		// The first tool wins when two names normalize to the same identifier.
		if (!(jsName in tools)) {
			tools[jsName] = fn;
			allTools.push(Object.freeze({ name: jsName, description }));
		}
		if (!(name in tools)) tools[name] = fn;
	}
	Object.freeze(tools);
	Object.freeze(allTools);

	// Reading a member that does not exist throws an error that names the close matches, instead of
	// a later "not a function". \`in\` checks still work.
	const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
	function guard(target, label, names, hint) {
		return new Proxy(target, {
			get(object, property, receiver) {
				if (typeof property !== "string" || property in object || property in Object.prototype || property === "then" || property === "toJSON") {
					return Reflect.get(object, property, receiver);
				}
				const wanted = comparable(property);
				const exact = names.filter((name) => comparable(name) === wanted);
				const close = exact.length > 0 ? exact : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
				let message = label + "." + property + " does not exist.";
				if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => label + "." + name).join(", ") + "?";
				else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
				if (hint) message += " " + hint;
				message += ' Check for a member with "' + property + '" in ' + label + ".";
				throw new TypeErrorCtor(message);
			},
		});
	}
	const toolsProxy = guard(
		tools,
		"tools",
		allTools.map((tool) => tool.name),
		"ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.",
	);

	const namespaces = new Map();
	for (const { name, spread } of parse(globalsJson)) {
		const fn = caller("global", name, spread);
		const dot = name.indexOf(".");
		if (dot === -1) {
			Object.defineProperty(globalThis, name, { value: fn, enumerable: true });
			continue;
		}
		const namespace = name.slice(0, dot);
		if (!namespaces.has(namespace)) namespaces.set(namespace, Object.create(null));
		namespaces.get(namespace)[name.slice(dot + 1)] = fn;
	}
	for (const [namespace, members] of namespaces) {
		Object.freeze(members);
		const value = guard(members, namespace, Object.keys(members));
		Object.defineProperty(globalThis, namespace, { value, enumerable: true });
	}

	// key -> JSON text. Sizes count key and JSON characters.
	const stored = new Map(Object.entries(parse(storeJson)));
	const writes = new Map();
	let storedChars = 0;
	for (const [key, json] of stored) storedChars += key.length + json.length;

	const STORE_HINT =
		"store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";

	function checkKey(name, key) {
		if (typeof key !== "string") throw new TypeError(name + "() key must be a string");
	}

	function store(key, value) {
		checkKey("store", key);
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		if (value === undefined) {
			stored.delete(key);
			storedChars -= previous;
			writes.set(key, undefined);
			return;
		}
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
		}
		if (json === undefined) {
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable");
		}
		if (json.length > 262144) {
			throw new RangeError(
				"store(" + stringify(key) + ") value has " + json.length + " characters of JSON, more than the limit of 262144. " +
					STORE_HINT,
			);
		}
		const next = storedChars - previous + key.length + json.length;
		if (next > 1048576) {
			throw new RangeError(
				"store is full: stored values would exceed 1048576 characters of JSON. Delete keys with store(key, undefined). " +
					STORE_HINT,
			);
		}
		stored.set(key, json);
		storedChars = next;
		writes.set(key, json);
	}

	function load(key) {
		checkKey("load", key);
		const json = stored.get(key);
		return json === undefined ? undefined : parse(json);
	}

	function serializeWrites() {
		const entries = [];
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		return stringify(entries);
	}

	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });

	// Primitives become their string form, everything else JSON.
	function outputText(value) {
		if (value === undefined || value === null || typeof value !== "object" && typeof value !== "function") {
			return String(value);
		}
		const json = stringify(value);
		return json === undefined ? String(value) : json;
	}

	function text(value) {
		let rendered;
		try {
			rendered = outputText(value);
		} catch (error) {
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		if (!finished) bridge("output", "text", rendered);
	}

	function imageUrl(value) {
		if (typeof value === "string") return value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new TypeErrorCtor(${JSON.stringify(z)});
		}
		if (value.image_url !== undefined) {
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(z)});
			return value.image_url;
		}
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(z)});
		if (value.type !== "image") {
			throw new TypeErrorCtor('image only accepts MCP image blocks, got "' + value.type + '"');
		}
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image expected MCP image data");
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		return "data:;base64," + value.data;
	}

	// Base64 of the signatures of the formats providers accept inline (PNG, JPEG except
	// JPEG-LS, GIF, "RIFF....WEBP"). Signatures start at byte 0, so their encodings are prefixes.
	const IMAGE_SIGNATURES = [
		["image/png", /^iVBORw0KGg/],
		["image/jpeg", /^[/]9j[/](?!9)/],
		["image/gif", /^R0lGOD[dl]h/],
		["image/webp", /^UklG.{8}RUJQ/],
	];

	function image(value) {
		const url = imageUrl(value);
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(z)});
		const colon = url.indexOf(":");
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		if (scheme === "http" || scheme === "https") {
			throw new TypeErrorCtor("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
		}
		const comma = url.indexOf(",");
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			throw new TypeErrorCtor("invalid image output. Pass a base64 data URI instead");
		}
		// Providers reject the whole request on a bad image, and a persisted image block would be
		// resent on every later turn. Line breaks from wrapped base64 are dropped. The declared type
		// is ignored in favor of the detected one, as providers also reject mismatches.
		const data = url.slice(comma + 1).replace(/\\s+/g, "");
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			throw new TypeErrorCtor("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
		}
		const head = data.slice(0, 16);
		const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
		if (!signature) {
			throw new TypeErrorCtor("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
		}
		if (!finished) bridge("output", "image", data, signature[0]);
	}

	function exit() {
		let writesJson;
		try {
			writesJson = serializeWrites();
		} catch (error) {
			done(false, describeError(error));
			throw EXIT;
		}
		done(true, undefined, writesJson);
		throw EXIT;
	}

	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...args) => {
			if (!finished) bridge("output", "text", args.map(format).join(" "));
		};
	}
	Object.freeze(console);

	Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
	Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
	Object.defineProperty(globalThis, "image", { value: image, enumerable: true });
	Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

	return {
		settle(id, ok, payload) {
			const entry = pending.get(id);
			if (!entry) return;
			pending.delete(id);
			if (!ok) {
				entry.reject(new ErrorCtor(payload));
				return;
			}
			let value;
			try {
				value = payload === undefined ? undefined : parse(payload);
			} catch (error) {
				entry.reject(error);
				return;
			}
			entry.resolve(value);
		},
		run(fn) {
			let promise;
			try {
				promise = fn(toolsProxy, console);
			} catch (error) {
				done(false, describeError(error));
				return;
			}
			promiseThen.call(
				promise,
				(value) => {
					let json;
					try {
						json = serialize(value);
					} catch (error) {
						done(false, describeError(error));
						return;
					}
					done(true, json, serializeWrites());
				},
				(error) => {
					done(false, describeError(error));
				},
			);
		},
		stalled() {
			if (finished || pending.size > 0) return false;
			done(
				false,
				stringify({
					name: "Error",
					message:
						"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.",
				}),
			);
			return true;
		},
	};
})`;function K(o){return typeof o=="object"&&o!==null&&o.type==="result"}function A(o){T.parentPort?.postMessage(o)}function Y(o){A({type:"crash",message:o instanceof Error?`${o.name}: ${o.message}`:String(o)})}function ie(o){return{fd_write(e,t,r,s){let n=new DataView(o.buffer),a=0;for(let i=0;i<r;i++)a+=n.getUint32(t+i*8+4,!0);return n.setUint32(s,a,!0),0}}}function ae(o){let e=o.message?`${o.name}: ${o.message}`:o.name,t=o.stack?.trimEnd();return JSON.stringify({name:o.name,message:o.message,stack:t?`${e}
${t}`:e})}async function le(o){let e=new Int32Array(o.interrupt),t=await H.create({wasm:o.wasm,memoryLimit:o.memoryLimitBytes,maxStackSize:D,interruptHandler:()=>Atomics.load(e,0)!==0,wasi:ie}),r=t.newFunction("bridge",(l,p,f,h)=>{switch(l.toString()){case"call":case"global":A({type:"call",id:p.toNumber(),target:l.toString()==="call"?"tool":"global",name:f.toString(),args:h===void 0||h.isUndefined?void 0:h.toString()});break;case"output":A({type:"output",item:p.toString()==="image"?{type:"image",data:f.toString(),mimeType:h.toString()}:{type:"text",text:f.toString()}});break;case"done":p.toBoolean()?A({type:"done",ok:!0,value:f===void 0||f.isUndefined?void 0:f.toString(),writes:h.toString()}):A({type:"done",ok:!1,error:f.toString()});break}return t.undefined}),s=t.withScope(l=>l.escape(t.callFunction(t.evalCode(X,"codemode-prelude.js"),t.undefined,r,t.newString(JSON.stringify(o.tools)),t.newString(JSON.stringify(o.globals)),t.newString(JSON.stringify(o.store))))),n=s.getProp("settle"),a=s.getProp("run"),i=s.getProp("stalled"),c=()=>{t.executePendingJobs(),t.callFunction(i,s).dispose()};T.parentPort?.on("message",l=>{if(K(l))try{t.withScope(()=>{t.callFunction(n,s,t.newNumber(l.id),l.ok?t.true:t.false,l.payload===void 0?t.undefined:t.newString(l.payload))}),c()}catch(p){Y(p)}});let u;try{u=t.evalCode(`(async (tools, console) => {${o.code}
})`,"codemode.js")}catch(l){if(!(l instanceof v))throw l;A({type:"done",ok:!1,error:ae(l)});return}t.callFunction(a,s,u).dispose(),u.dispose(),c()}T.parentPort&&le(T.workerData).catch(Y);
