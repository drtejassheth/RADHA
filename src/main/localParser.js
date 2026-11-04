// Runs the local Python parsing sidecar (python/parse_report.py) and returns its JSON output.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In the packaged app the script is unpacked from app.asar so Python can read it.
const SCRIPT = path.resolve(__dirname, '..', '..', 'python', 'parse_report.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function runPython(pythonPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [SCRIPT, ...args], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Local parser timed out after ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Python ("${pythonPath}"): ${e.message}. Set the Python path in Settings.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(out); } catch { /* fall through */ }
      if (parsed && parsed.error) return reject(new Error(parsed.error));
      if (code !== 0 || !parsed) {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        return reject(new Error(`Local parser failed (exit ${code}).\n${tail}`));
      }
      resolve(parsed);
    });
  });
}

export function parseLocal(filePath, engine, { pythonPath }) {
  // Docling / Marker / EasyOCR download models on first use, so allow plenty of time.
  return runPython(pythonPath, ['--engine', engine || 'auto', '--file', filePath], 15 * 60_000);
}

export function checkPythonEngines({ pythonPath }) {
  return runPython(pythonPath, ['--check'], 60_000);
}
