// Minimal WebGL renderer for a Live2D Cubism model, driven straight by the official Cubism Core.
// The pet does not need PIXI or the Cubism Framework: parameters are animated by pet-rig.js, so this
// file only loads the .moc3 + atlas and draws drawables in render order, with stencil clipping masks.
(function () {
  'use strict';
  // The Core reports UVs with v pointing up (Cubism's own renderer flips it the same way).
  const VS = 'attribute vec2 a_pos;attribute vec2 a_uv;uniform mat3 u_mat;varying vec2 v_uv;'
    + 'void main(){vec3 p=u_mat*vec3(a_pos,1.0);gl_Position=vec4(p.xy,0.0,1.0);v_uv=vec2(a_uv.x,1.0-a_uv.y);}';
  const FS = 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex;uniform float u_alpha;uniform float u_mask;'
    + 'void main(){vec4 c=texture2D(u_tex,v_uv);if(u_mask>0.5){if(c.a<0.5)discard;gl_FragColor=vec4(0.0);return;}'
    + 'gl_FragColor=c*u_alpha;}';

  function request(url, type) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = type;
      xhr.onload = () => (xhr.status === 0 || xhr.status === 200) && xhr.response ? resolve(xhr.response)
        : reject(new Error(`无法读取 ${url}`));
      xhr.onerror = () => reject(new Error(`无法读取 ${url}`));
      xhr.send();
    });
  }

  function image(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`无法读取 ${url}`));
      img.src = url;
    });
  }

  // The Core's WebAssembly instantiates asynchronously; calls throw until it is ready.
  async function coreReady(timeout = 8000) {
    const start = performance.now();
    for (;;) {
      try {
        if (window.Live2DCubismCore && Live2DCubismCore.Version.csmGetVersion() > 0) return;
      } catch { /* not ready yet */ }
      if (performance.now() - start > timeout) throw new Error('Live2D Cubism Core 初始化超时');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  class Puppet {
    constructor(gl, model, textures) {
      this.gl = gl;
      this.model = model;
      this.textures = textures;
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      this.program = program;
      this.loc = {
        pos: gl.getAttribLocation(program, 'a_pos'), uv: gl.getAttribLocation(program, 'a_uv'),
        mat: gl.getUniformLocation(program, 'u_mat'), tex: gl.getUniformLocation(program, 'u_tex'),
        alpha: gl.getUniformLocation(program, 'u_alpha'), mask: gl.getUniformLocation(program, 'u_mask'),
      };
      const d = model.drawables;
      this.buffers = [];
      for (let i = 0; i < d.count; i++) {
        const pos = gl.createBuffer();
        const uv = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uv);
        gl.bufferData(gl.ARRAY_BUFFER, d.vertexUvs[i], gl.STATIC_DRAW);
        const index = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.indices[i], gl.STATIC_DRAW);
        this.buffers.push({ pos, uv, index, count: d.indexCounts[i] });
      }
      const p = model.parameters;
      this.index = new Map();
      for (let i = 0; i < p.count; i++) this.index.set(p.ids[i], i);
      const c = model.canvasinfo;
      this.canvas = { width: c.CanvasWidth, height: c.CanvasHeight, originX: c.CanvasOriginX,
        originY: c.CanvasOriginY, ppu: c.PixelsPerUnit };
    }

    has(id) { return this.index.has(id); }

    // Bounding box of everything visible at the current parameters, in model-canvas px (y down).
    bounds() {
      this.model.update();
      const d = this.model.drawables;
      const { originX, originY, ppu } = this.canvas;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < d.count; i++) {
        if (d.opacities[i] < .01) continue;
        const v = d.vertexPositions[i];
        for (let k = 0; k < v.length; k += 2) {
          const x = originX + v[k] * ppu, y = originY - v[k + 1] * ppu;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return [x0, y0, x1, y1];
    }

    set(id, value) {
      const i = this.index.get(id);
      if (i === undefined) return;
      const p = this.model.parameters;
      p.values[i] = Math.max(p.minimumValues[i], Math.min(p.maximumValues[i], value));
    }

    defaults() {
      const p = this.model.parameters;
      for (let i = 0; i < p.count; i++) p.values[i] = p.defaultValues[i];
    }

    // canvasToClip: [a, b, c, d, e, f] mapping model-canvas pixels (y down) to clip space.
    draw(canvasToClip, opacity = 1) {
      const { gl, model, loc } = this;
      model.update();
      const d = model.drawables;
      const { originX, originY, ppu } = this.canvas;
      const [a, b, c, dd, e, f] = canvasToClip;
      // Core vertex units are y-up around the canvas origin: px = ox + x*ppu, py = oy - y*ppu.
      const m = new Float32Array([a * ppu, b * ppu, 0, -c * ppu, -dd * ppu, 0,
        a * originX + c * originY + e, b * originX + dd * originY + f, 1]);
      gl.useProgram(this.program);
      gl.uniformMatrix3fv(loc.mat, false, m);
      gl.uniform1i(loc.tex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      const order = this.order || (this.order = new Int32Array(d.count));
      for (let i = 0; i < d.count; i++) order[d.renderOrders[i]] = i;
      for (let r = 0; r < d.count; r++) {
        const i = order[r];
        const alpha = d.opacities[i] * opacity;
        if (alpha < 0.004 || !(d.dynamicFlags[i] & 1)) continue;
        const masks = d.maskCounts[i] > 0 ? d.masks[i] : null;
        if (masks) {
          gl.enable(gl.STENCIL_TEST);
          gl.clearStencil(0);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.colorMask(false, false, false, false);
          for (let k = 0; k < d.maskCounts[i]; k++) this.mesh(masks[k], 1, true);
          gl.colorMask(true, true, true, true);
          gl.stencilFunc(gl.EQUAL, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          this.mesh(i, alpha, false);
          gl.disable(gl.STENCIL_TEST);
        } else {
          this.mesh(i, alpha, false);
        }
      }
      d.resetDynamicFlags();
    }

    mesh(i, alpha, asMask) {
      const { gl, loc } = this;
      const d = this.model.drawables;
      const buf = this.buffers[i];
      gl.bindTexture(gl.TEXTURE_2D, this.textures[d.textureIndices[i]]);
      gl.uniform1f(loc.alpha, alpha);
      gl.uniform1f(loc.mask, asMask ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos);
      gl.bufferData(gl.ARRAY_BUFFER, d.vertexPositions[i], gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.pos);
      gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.uv);
      gl.enableVertexAttribArray(loc.uv);
      gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.index);
      gl.drawElements(gl.TRIANGLES, buf.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  async function load(canvas, modelUrl) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, stencil: true, antialias: true });
    if (!gl) throw new Error('当前环境不支持 WebGL');
    await coreReady();
    const base = modelUrl.slice(0, modelUrl.lastIndexOf('/') + 1);
    const settings = await request(modelUrl, 'json');
    const refs = settings.FileReferences;
    const moc = Live2DCubismCore.Moc.fromArrayBuffer(await request(base + refs.Moc, 'arraybuffer'));
    if (!moc) throw new Error('Live2D 模型文件无效');
    const model = Live2DCubismCore.Model.fromMoc(moc);
    if (!model) throw new Error('Live2D 模型初始化失败');
    const textures = [];
    for (const file of refs.Textures) {
      const img = await image(base + file);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures.push(tex);
    }
    return new Puppet(gl, model, textures);
  }

  window.Live2DLite = { load };
})();
