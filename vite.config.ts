import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * WASM variants `FilesetResolver.forVisionTasks(root)` can ask for.
 *
 * Its path builder is `vision_wasm${module ? '_module' : ''}${simd ? '' : '_nosimd'}_internal`,
 * and we never pass the `module` flag, so only these two pairs are reachable.
 * Shipping the `_module_` pair would add ~11MB that nothing ever requests.
 *
 * The nosimd pair IS shipped even though every current browser and OBS's CEF
 * support SIMD: a missing fallback would 404 inside the landmarker and read as
 * "tracking silently doesn't work" on older hardware.
 */
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const WASM_ROUTE = /\/mediapipe\/wasm\/([\w.-]+)$/;
const FIXTURE_ROUTE = /\/fixtures\/([\w.-]+)$/;

function mediapipeWasmDir(): string {
  // Resolve through node's own resolution rather than a hardcoded path, so the
  // vendored bytes can never drift from the version in package.json.
  return path.join(path.dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
}

/**
 * Serves MediaPipe's WASM from `node_modules` in dev and copies it into the
 * build, so the app never depends on a CDN at runtime.
 *
 * Deliberately not a hand-copy into `public/`: copied files go stale on the next
 * `npm update`, and the failure mode is a WASM/JS ABI mismatch deep inside a
 * landmarker — the last thing anyone wants to debug mid-broadcast.
 */
function mediapipeAssets(): Plugin {
  return {
    name: 'vrm-stage:mediapipe-assets',

    configureServer(server) {
      const dir = mediapipeWasmDir();
      server.middlewares.use((req, res, next) => {
        const match = req.url ? WASM_ROUTE.exec(req.url.split('?')[0] ?? '') : null;
        const name = match?.[1];
        if (!name || !WASM_FILES.includes(name)) return next();

        const file = path.join(dir, name);
        if (!existsSync(file)) return next();

        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        res.end(readFileSync(file));
      });
    },

    generateBundle() {
      const dir = mediapipeWasmDir();
      for (const name of WASM_FILES) {
        const file = path.join(dir, name);
        if (!existsSync(file)) {
          this.error(
            `Missing MediaPipe asset ${name} at ${file}. ` +
              'Reinstall @mediapipe/tasks-vision.',
          );
        }
        this.emitFile({
          type: 'asset',
          fileName: `mediapipe/wasm/${name}`,
          source: readFileSync(file),
        });
      }
    },
  };
}

/**
 * Serves the licence-restricted regression fixtures in dev only.
 *
 * They used to live in `public/`, where a `postbuild` rm was the single thing
 * standing between two author-only, redistribution-prohibited VRMs and a public
 * deploy — and it failed silently. Keeping them outside `public/` makes shipping
 * them impossible rather than merely discouraged.
 */
function devFixtures(): Plugin {
  return {
    name: 'vrm-stage:dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      const dir = path.resolve(server.config.root, 'fixtures');
      server.middlewares.use((req, res, next) => {
        const match = req.url ? FIXTURE_ROUTE.exec(req.url.split('?')[0] ?? '') : null;
        const name = match?.[1];
        if (!name || !name.endsWith('.vrm')) return next();

        const file = path.join(dir, name);
        if (!existsSync(file)) return next();

        res.setHeader('Content-Type', 'model/gltf-binary');
        res.end(readFileSync(file));
      });
    },
  };
}

/** Fails the build if a licence-restricted model reached the output. */
function assertNoModelsShipped(): Plugin {
  return {
    name: 'vrm-stage:assert-no-models',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(this.environment?.config?.build?.outDir ?? 'dist');
      if (!existsSync(outDir)) return;

      const strays: string[] = [];
      const unreadable: string[] = [];

      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          // On Windows a running `wrangler dev` holds dist/ open through its
          // assets binding, and scanning throws EPERM. That is a file lock, not
          // a licence violation — a guard that fails the build over it is a
          // guard people disable.
          unreadable.push(path.relative(outDir, dir) || '.');
          return;
        }

        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.toLowerCase().endsWith('.vrm')) strays.push(full);
        }
      };
      walk(outDir);

      // A model that actually reached the output is still a hard failure: these
      // are author-only, redistribution-prohibited files.
      if (strays.length > 0) {
        throw new Error(
          `Refusing to ship VRM files: ${strays.join(', ')}. ` +
            'Models are author-licensed; they must not be bundled.',
        );
      }

      if (unreadable.length > 0) {
        console.warn(
          `\n[vrm-stage] Could not scan ${unreadable.join(', ')} for stray models — ` +
            'something has dist/ open, usually `npm run serve`.\n' +
            '            The build is fine; the licence check just could not verify those paths.\n',
        );
      }
    },
  };
}

export default defineConfig({
  // Set VITE_BASE to host under a subpath, e.g. VITE_BASE=/vrm/ npm run build.
  base: process.env['VITE_BASE'] ?? '/',
  plugins: [mediapipeAssets(), devFixtures(), assertNoModelsShipped()],
  server: {
    port: 5173,
    // OBS's browser source hits the dev server from a CEF instance; allow it.
    host: true,
    // Broadcast rooms live in the Worker (`npm run serve`). Proxying means the
    // app uses the same relative /api paths in dev and production — `ws: true`
    // matters because the room is a WebSocket.
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
