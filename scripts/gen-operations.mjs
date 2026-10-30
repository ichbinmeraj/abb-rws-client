#!/usr/bin/env node
/**
 * `npm run ops:gen` / `npm run ops:check` - src/operations/generated.ts, the
 * route, parameters, access and read-back of every operation key (1.6.0).
 *
 *   node scripts/gen-operations.mjs          # rewrite src/operations/generated.ts
 *   node scripts/gen-operations.mjs --check  # exit 1 when the file differs
 *
 * Inputs: the path tables (from dist/, the npm scripts build first), the
 * method signatures of RobotManager, IRWSAdapter, RwsClient2 and RWS1Adapter
 * (read with the TypeScript compiler), and the decisions in
 * scripts/operations-spec.mjs. The file is never edited by hand.
 *
 * `generateOperations` is exported so the unit tests run it against the
 * tables in src and compare with the file on disk.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A method body that takes access itself: the AccessManager and RobotManager wrappers. */
const ACCESS_RE = /\b(withAccess|withMastership|withStartMastership|withCfgAccess|sendFirst|exclusive)\s*\(/;

/** Method declarations of every class in `files`, by name: their parameters and body text. */
function methodBodies(ts, files, className) {
  const out = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node, inClass) => {
      const isClass = ts.isClassDeclaration(node) || ts.isClassExpression(node);
      const named = isClass && (className === undefined || node.name?.text === className);
      for (const m of isClass && named ? node.members : []) {
        if (!ts.isMethodDeclaration(m) || !m.body || !m.name) { continue; }
        const mods = ts.getModifiers(m) ?? [];
        const isPrivate = mods.some(x => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword);
        const name = m.name.getText(sf);
        out.set(name, { body: (out.get(name)?.body ?? '') + m.body.getText(sf), isPrivate });
      }
      ts.forEachChild(node, c => visit(c, inClass || isClass));
    };
    visit(sf, false);
  }
  return out;
}

/** The call signature of `owner`'s member `name` as parameter descriptions, or null. */
function paramsOf(ts, checker, owner, name) {
  const prop = owner.type.getProperty(name);
  if (!prop) { return null; }
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  const type = checker.getTypeOfSymbolAtLocation(prop, decl ?? owner.node);
  const sig = checker.getNonNullableType(type).getCallSignatures()[0];
  if (!sig) { return null; }
  return sig.parameters.map(p => {
    const pd = p.valueDeclaration;
    const optional = !!pd && (!!pd.questionToken || !!pd.initializer || !!pd.dotDotDotToken);
    let typeText = pd?.type ? pd.type.getText() : checker.typeToString(checker.getTypeOfSymbolAtLocation(p, pd));
    typeText = typeText.replace(/\s+/g, ' ').trim();
    if (optional) { typeText = typeText.replace(/\s*\|\s*undefined$/, ''); }
    const param = { name: p.name.startsWith('__') ? 'options' : p.name, optional, type: typeText };
    if (pd?.dotDotDotToken) { param.rest = true; }
    return param;
  });
}

/** The adapter method names a manager body calls (`adapter.x(`, `this.adapter!.x(`, `adapter?.x`). */
function adapterCalls(body) {
  return [...body.matchAll(/\badapter\b[!?]?\??\.(\w+)/g)].map(m => m[1]);
}

/** `this.x(` calls in a body, one level of helpers. */
function selfCalls(body) {
  return [...body.matchAll(/\bthis\.(\w+)\s*\(/g)].map(m => m[1]);
}

/**
 * The generated file's text and a report, from the tables, the sources under
 * `root` and the spec.
 */
export function generateOperations({ ts, tables, root, spec }) {
  const src = join(root, 'src');
  const program = ts.createProgram([join(src, 'index.ts')], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: true, noEmit: true,
  });
  const checker = program.getTypeChecker();
  const owners = {};
  const find = (file, kind, name) => {
    const sf = program.getSourceFile(join(src, file));
    let node;
    ts.forEachChild(sf, n => { if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name?.text === name) { node = n; } });
    if (!node) { throw new Error(`gen-operations: ${kind} ${name} not found in ${file}`); }
    const sym = checker.getSymbolAtLocation(node.name);
    const type = kind === 'class' ? checker.getDeclaredTypeOfSymbol(sym) : checker.getDeclaredTypeOfSymbol(sym);
    owners[name] = { node, type };
  };
  find('RobotManager.ts', 'class', 'RobotManager');
  find('IRWSAdapter.ts', 'interface', 'IRWSAdapter');
  find('RwsClient2.ts', 'class', 'RwsClient2');
  find('RWS1Adapter.ts', 'class', 'RWS1Adapter');

  const managerBodies = methodBodies(ts, [join(src, 'RobotManager.ts')], 'RobotManager');
  const rws2Files = readdirSync(join(src, 'rws2')).filter(f => f.endsWith('.ts')).map(f => join(src, 'rws2', f));
  const rws2Bodies = methodBodies(ts, [...rws2Files, join(src, 'RwsClient2.ts')]);
  const rws1Bodies = methodBodies(ts, [join(src, 'RWS1Adapter.ts')], 'RWS1Adapter');

  const isManagerMethod = name => managerBodies.has(name) && !managerBodies.get(name).isPrivate
    && paramsOf(ts, checker, owners.RobotManager, name) !== null;
  const adapterOwner = name => ['IRWSAdapter', 'RwsClient2', 'RWS1Adapter'].find(o => paramsOf(ts, checker, owners[o], name) !== null);

  /** Whether the RWS 2.0 body of adapter method `name`, or a helper it calls, takes access. */
  const rws2TakesAccess = (name, depth = 0) => {
    const body = rws2Bodies.get(name)?.body ?? '';
    if (ACCESS_RE.test(body)) { return true; }
    return depth < 1 && selfCalls(body).some(h => h !== name && rws2TakesAccess(h, depth + 1));
  };
  const selfAccessOf = route => {
    if (route.via === 'manager') {
      const body = managerBodies.get(route.method)?.body ?? '';
      return ACCESS_RE.test(body) || adapterCalls(body).some(m => rws2TakesAccess(m));
    }
    if (route.via === 'manager-by-arg') { return Object.values(route.methods).every(m => selfAccessOf({ via: 'manager', method: m })); }
    if (route.via === 'adapter') { return rws2TakesAccess(route.method); }
    return false;
  };

  const problems = [];
  const entries = [];
  const sideOf = s => (s === undefined ? 'none' : s.gap ? 'gap' : 'sent');

  for (const [domain, table] of Object.entries(tables)) {
    for (const [id, op] of Object.entries(table)) {
      const key = `${domain}.${id}`;
      const generations = ['rws1', 'rws2'].filter(g => sideOf(op[g]) === 'sent');
      let route;
      if (op.access) { route = { via: 'none', reason: 'access' }; }
      else if (op.effect === 'session') { route = { via: 'none', reason: 'session' }; }
      else if (generations.length === 0) { route = { via: 'none', reason: 'gap' }; }
      else if (spec.ROUTE_EXCEPTIONS[key]) { route = spec.ROUTE_EXCEPTIONS[key]; }
      else if (isManagerMethod(id)) { route = { via: 'manager', method: id }; }
      else if (adapterOwner(id)) { route = { via: 'adapter', method: id }; }
      else { problems.push(`${key}: no RobotManager or adapter method of that name, and no exception`); continue; }
      entries.push({ key, domain, id, kind: 'row', effect: op.effect, generations, route, rws2Verb: op.rws2?.gap ? undefined : op.rws2?.method });
    }
  }
  for (const c of spec.COMPOSITES) {
    const key = `${c.domain}.${c.id}`;
    if (tables[c.domain]?.[c.id]) { problems.push(`${key}: a composite key collides with a table row`); }
    for (const s of c.sends) {
      const [d, i] = s.split('.');
      if (!tables[d]?.[i]) { problems.push(`${key}: sends ${s}, which is not a table row`); }
    }
    entries.push({ key, domain: c.domain, id: c.id, kind: 'composite', effect: c.effect, generations: c.generations, route: c.route });
  }

  // Parameters, from the method the route reaches.
  for (const e of entries) {
    const r = e.route;
    let params = [];
    if (r.via === 'manager') {
      params = paramsOf(ts, checker, owners.RobotManager, r.method);
      if (!params) { problems.push(`${e.key}: RobotManager.${r.method} is not a method`); params = []; }
    } else if (r.via === 'adapter') {
      const owner = adapterOwner(r.method);
      params = owner ? paramsOf(ts, checker, owners[owner], r.method) : null;
      if (!params) { problems.push(`${e.key}: no adapter method ${r.method}`); params = []; }
    } else if (r.via === 'manager-by-arg') {
      const owner = adapterOwner(r.params.method);
      params = owner ? paramsOf(ts, checker, owners[owner], r.params.method) : [];
      for (const m of Object.values(r.methods)) { if (!isManagerMethod(m)) { problems.push(`${e.key}: RobotManager.${m} is not a method`); } }
    }
    // The names a caller sees: RobotManager's own are often one letter
    // (`getCfgInstance(d, t, i)`), so they come from the adapter's method of
    // the row's name where it takes as many parameters. Types stay those of
    // the method the route reaches.
    const named = adapterOwner(e.id) ? paramsOf(ts, checker, owners[adapterOwner(e.id)], e.id) : null;
    if (named && named.length === params.length && (r.via === 'manager' || r.via === 'adapter')) {
      params = params.map((p, i) => ({ ...p, name: named[i].name }));
    }
    e.params = params;
    // The adapter method a manager route relies on: RobotManager answers a
    // neutral value ({}, [], null) when the adapter lacks it, so call()
    // refuses first instead. `adapterMethod: null` in the spec turns it off,
    // for a manager method that sends through other adapter methods.
    if (r.via === 'manager' && r.adapterMethod === null) {
      const { adapterMethod: _off, ...rest } = r;
      e.route = rest;
    } else if (r.via === 'manager' && !r.adapterMethod) {
      const relied = [e.id, r.method].find(m => adapterOwner(m));
      if (relied) { e.route = { ...r, adapterMethod: relied }; }
    } else if (r.via === 'manager-by-arg' && !r.adapterMethod) {
      e.route = { ...r, adapterMethod: r.params.method };
    }
    // RobotWare 8 write access: `self` when the method takes it, `call` when
    // RobotManager.call takes it around the method, `none` for a read and for
    // a write sent as a GET (the DIPC read, held open up to 280 s), and what
    // RW8_ACCESS_EXCEPTIONS names (the simulated stops).
    const exception = (spec.RW8_ACCESS_EXCEPTIONS ?? {})[e.key];
    e.rw8Access = e.effect !== 'write' || r.via === 'none' ? 'none'
      : exception ? exception
      : selfAccessOf(r) ? 'self'
      : e.rws2Verb === 'GET' ? 'none'
      : 'call';
  }
  for (const [key, value] of Object.entries(spec.RW8_ACCESS_EXCEPTIONS ?? {})) {
    const e = entries.find(x => x.key === key);
    if (!e || e.effect !== 'write' || e.route.via === 'none') { problems.push(`RW8_ACCESS_EXCEPTIONS: ${key} is not a routed write`); }
    if (!['none', 'self', 'call'].includes(value)) { problems.push(`RW8_ACCESS_EXCEPTIONS: ${key} has ${value}, not none, self or call`); }
  }

  // Read-backs: every routed write names its read, or null.
  const byKey = new Map(entries.map(e => [e.key, e]));
  for (const e of entries) {
    if (e.effect !== 'write' || e.route.via === 'none') { e.readBack = null; continue; }
    if (!(e.key in spec.READ_BACKS)) { problems.push(`${e.key}: a write with no READ_BACKS entry`); e.readBack = null; continue; }
    const rb = spec.READ_BACKS[e.key];
    if (rb === null) { e.readBack = null; continue; }
    const target = byKey.get(typeof rb === 'string' ? rb : rb.key);
    if (!target) { problems.push(`${e.key}: read-back ${JSON.stringify(rb)} is not a key`); e.readBack = null; continue; }
    if (target.effect !== 'read' || target.route.via === 'none') { problems.push(`${e.key}: read-back ${target.key} is not a routed read`); }
    const missing = e.generations.filter(g => !target.generations.includes(g));
    if (missing.length && !(typeof rb === 'object' && rb.partial)) {
      problems.push(`${e.key}: read-back ${target.key} has no ${missing.join(', ')} side (mark it partial: true to accept)`);
    }
    let args = typeof rb === 'string' ? undefined : rb.args;
    if (!args) {
      args = [];
      for (const p of target.params) {
        if (e.params.some(w => w.name === p.name)) { args.push(p.name); continue; }
        if (!p.optional) { problems.push(`${e.key}: read-back ${target.key} needs ${p.name}, which the write does not take`); }
        break;
      }
    }
    for (const a of args) { if (!e.params.some(w => w.name === a)) { problems.push(`${e.key}: read-back argument ${a} is not a parameter of the write`); } }
    e.readBack = { key: target.key, args, generations: e.generations.filter(g => target.generations.includes(g)) };
  }
  for (const k of Object.keys(spec.READ_BACKS)) {
    const e = byKey.get(k);
    if (!e || e.effect !== 'write' || e.route.via === 'none') { problems.push(`READ_BACKS ${k}: not a routed write`); }
  }

  /** A value as TypeScript source: single-quoted strings, bare keys where they are identifiers. */
  const lit = v => {
    if (v === null) { return 'null'; }
    if (typeof v === 'string') { return `'${v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`; }
    if (typeof v !== 'object') { return String(v); }
    if (Array.isArray(v)) { return `[${v.map(lit).join(', ')}]`; }
    const key = k => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k));
    return `{ ${Object.entries(v).map(([k, x]) => `${key(k)}: ${lit(x)}`).join(', ')} }`;
  };
  const lines = [];
  lines.push('// Generated by scripts/gen-operations.mjs (npm run ops:gen). Do not edit by hand:');
  lines.push('// change the path tables, a method signature or scripts/operations-spec.mjs, then regenerate.');
  lines.push('');
  lines.push('/** The route of every operation key: the RobotManager or adapter method `RobotManager.call` reaches. */');
  lines.push('export const OPERATION_ROUTES = {');
  for (const e of entries) { lines.push(`  '${e.key}': ${lit(e.route)},`); }
  lines.push('} as const;');
  lines.push('');
  lines.push('/** Per key: the parameters in call order, who takes RobotWare 8 write access, the read-back. */');
  lines.push('export const OPERATION_DETAILS = {');
  for (const e of entries) {
    lines.push(`  '${e.key}': { params: ${lit(e.params)}, rw8Access: '${e.rw8Access}', readBack: ${lit(e.readBack)} },`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('/** The operations the client sends with no table row of its own. */');
  lines.push('export const COMPOSITE_OPERATIONS = [');
  for (const c of spec.COMPOSITES) {
    const { route: _route, ...rest } = c;
    lines.push(`  ${lit(rest)},`);
  }
  lines.push('] as const;');
  lines.push('');
  return { text: lines.join('\n'), problems, entries };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ts = createRequire(join(root, 'package.json'))('typescript');
  const { ALL_TABLES } = await import(pathToFileURL(join(root, 'dist', 'paths', 'index.js')).href);
  const spec = await import(pathToFileURL(join(root, 'scripts', 'operations-spec.mjs')).href);
  const { text, problems } = generateOperations({ ts, tables: ALL_TABLES, root, spec });
  if (problems.length) {
    for (const p of problems) { console.error(`gen-operations: ${p}`); }
    process.exit(1);
  }
  const out = join(root, 'src', 'operations', 'generated.ts');
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(out, 'utf8'); } catch { /* missing */ }
    if (current.replace(/\r\n/g, '\n') !== text) {
      console.error('gen-operations: src/operations/generated.ts differs from the tables and signatures; run npm run ops:gen');
      process.exit(1);
    }
    console.log('gen-operations: src/operations/generated.ts is current');
  } else {
    writeFileSync(out, text);
    console.log(`gen-operations: wrote ${out}`);
  }
}
