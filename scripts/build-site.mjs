// Copies the wire's published JSON next to the static site. Netlify runs this; it is
// deliberately the entire build step.
import fs from 'node:fs';
import path from 'node:path';
const from = path.join(process.cwd(), 'data', 'site');
const to = path.join(process.cwd(), 'site');
fs.mkdirSync(to, { recursive: true });
let n = 0;
for (const f of fs.existsSync(from) ? fs.readdirSync(from) : []) {
  fs.copyFileSync(path.join(from, f), path.join(to, f));
  n++;
}
if (!n) {
  // First deploy, before the wire has ever run. Emit an empty wire so the page renders
  // instead of 404ing on fetch.
  fs.writeFileSync(path.join(to, 'wire.json'), JSON.stringify({ generatedAt: null, counts: {}, offers: [] }));
  fs.writeFileSync(path.join(to, 'status.json'), JSON.stringify({ generatedAt: null, log: ['wire has not run yet'] }));
}
console.log(`build-site: ${n} file(s)`);
