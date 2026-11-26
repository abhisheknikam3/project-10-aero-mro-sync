#!/usr/bin/env node
/**
 * Aero-MRO-Sync - local mock upstream (no dependencies, Node 14+)
 *   Primary MRO ERP   : http://localhost:3001
 *   Secondary MRO ERP : http://localhost:3002   (hot-failover target)
 *
 * Endpoints (both servers):
 *   POST   /graphql                         fleet hours + depots (spec 6.2)
 *   GET    /files/faa_8130_3_release_cert.pdf   valid FAA 8130-3 (checksum OK)
 *   GET    /files/faa_8130_3_TAMPERED.pdf       checksum mismatch (TC-05)
 *   POST   /oauth/token                     client_credentials
 *   POST   /v1/aog/work-orders              201
 *   PUT    /v1/fleet/:tail/airworthiness    200
 *   PATCH  /v1/parts/:serial/status         200
 *   DELETE /v1/gates/:id                    204, or 400 for unknown gate (TC-07)
 *   GET    /v2/fleet/acars-history          RFC 5988 Link header pagination
 * Control (fault injection):
 *   POST /__mock/force  {"status":503,"times":1,"pathContains":"/v1/fleet","server":"primary"}
 *   POST /__mock/reset
 *   GET  /__mock/log
 * Per-request override: header  x-mock-force-status: 503
 */
const http = require('http');

const KNOWN_GATES = new Set(['GATE-ORD-B14']);
const forced = [];           // {status, times, pathContains, server}
const log = [];

function buildPdf(lines) {
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let stream = 'BT\n/F1 11 Tf\n50 760 Td\n15 TL\n';
  lines.forEach((l, i) => { stream += (i ? 'T* ' : '') + '(' + esc(l) + ') Tj\n'; });
  stream += 'ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream'
  ];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}
const certLines = (checksum) => [
  'FAA FORM 8130-3 - AUTHORIZED RELEASE CERTIFICATE (AIRWORTHINESS)',
  '======================================================================',
  'Tracking Number : FAA-8130-551029',
  'Part Number : CFM-HPT-BLADE-9',
  'Spare Serial : SN-SPARE-DTW04',
  'Inspection Date : 10/11/2026',
  'Status : NEW / AIRWORTHY (PART 145 CERTIFIED)',
  'Remaining Cycles: 10000',
  'CERT_CYCLE_CHECKSUM: ' + checksum,
  '======================================================================'
];

function readBody(req) {
  return new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString('utf8'))); });
}

function makeServer(port, label) {
  const send = (res, code, obj, headers = {}) => {
    const isBuf = Buffer.isBuffer(obj);
    const payload = obj === undefined ? '' : isBuf ? obj : JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': isBuf ? 'application/pdf' : 'application/json', ...headers });
    res.end(payload);
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname, m = req.method;
    const body = await readBody(req);
    log.push({ t: new Date().toISOString(), server: label, method: m, path: p + url.search });
    if (log.length > 200) log.shift();
    console.log(`[${label}] ${m} ${p}${url.search}`);

    // ---- control plane ----
    if (p === '/__mock/force' && m === 'POST') { const j = JSON.parse(body || '{}'); forced.push({ times: 1, server: 'primary', ...j }); return send(res, 200, { forced }); }
    if (p === '/__mock/reset') { forced.length = 0; log.length = 0; return send(res, 200, { ok: true }); }
    if (p === '/__mock/log') return send(res, 200, log);

    // ---- fault injection ----
    const hdrForce = Number(req.headers['x-mock-force-status']);
    if (hdrForce) return send(res, hdrForce, { error: 'forced by header', status: hdrForce }, hdrForce === 429 ? { 'Retry-After': '1', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 5) } : {});
    const f = forced.find(x => x.times > 0 && x.server === label && (!x.pathContains || p.includes(x.pathContains)));
    if (f) { f.times -= 1; return send(res, f.status, { error: 'forced by control plane', status: f.status }, f.status === 429 ? { 'Retry-After': '1' } : {}); }

    // ---- public ----
    if (p === '/graphql' && m === 'POST') {
      let v = {}; try { v = JSON.parse(body).variables || {}; } catch (e) {}
      return send(res, 200, { data: { fleetPartStatus: {
        tailNumber: v.tailNumber || 'N842UA', airportIata: 'ORD', airportLat: 41.9742, airportLon: -87.9073,
        currentHours: 19200, maxHours: 20000, currentCycles: 9700, maxCycles: 10000, gateAssignmentId: null,
        depots: [
          { hubIata: 'ATL', lat: 33.6407, lon: -84.4277, certifiedStock: 2, spareSerial: 'SN-SPARE-ATL09' },
          { hubIata: 'DTW', lat: 42.2162, lon: -83.3554, certifiedStock: 1, spareSerial: 'SN-SPARE-DTW04' },
          { hubIata: 'LAX', lat: 33.9416, lon: -118.4085, certifiedStock: 4, spareSerial: 'SN-SPARE-LAX11' } ] } } });
    }
    if (p === '/files/faa_8130_3_release_cert.pdf') return send(res, 200, buildPdf(certLines(10000)));
    if (p === '/files/faa_8130_3_TAMPERED.pdf') return send(res, 200, buildPdf(certLines(9000)));
    if (p === '/oauth/token' && m === 'POST') return send(res, 200, { access_token: 'mock-' + label + '-' + Date.now(), token_type: 'Bearer', expires_in: 3600 });

    // ---- protected ----
    if (!/^Bearer\s+\S+/.test(req.headers.authorization || '')) return send(res, 401, { error: 'missing bearer token' });
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch (e) {}

    if (p === '/v1/aog/work-orders' && m === 'POST') return send(res, 201, { workOrderId: 'WO-' + Date.now(), status: 'CREATED', courierOriginHub: j.courierOriginHub, server: label });
    let mt;
    if ((mt = p.match(/^\/v1\/fleet\/([^/]+)\/airworthiness$/)) && m === 'PUT') return send(res, 200, { tail: decodeURIComponent(mt[1]), airworthinessStatus: j.airworthinessStatus, server: label });
    if ((mt = p.match(/^\/v1\/parts\/([^/]+)\/status$/)) && m === 'PATCH') return send(res, 200, { serial: decodeURIComponent(mt[1]), status: j.status, server: label });
    if ((mt = p.match(/^\/v1\/gates\/([^/]+)$/)) && m === 'DELETE') {
      const id = decodeURIComponent(mt[1]);
      if (!KNOWN_GATES.has(id)) return send(res, 400, { error: 'UNKNOWN_GATE', gate: id });
      res.writeHead(204); return res.end();
    }
    if (p === '/v2/fleet/acars-history' && m === 'GET') {
      const reset = String(Math.floor(Date.now() / 1000) + 5);
      if (!url.searchParams.get('cursor'))
        return send(res, 200, [{ faultId: 'ACARS-2026-HIST-1', code: 'EGT_EXCEEDANCE', tail: 'N842UA' }],
          { Link: `<http://${req.headers.host}/v2/fleet/acars-history?cursor=YWNhcnNfcGFnZV8y>; rel="next"`, 'X-RateLimit-Remaining': '4', 'X-RateLimit-Reset': reset });
      return send(res, 200, [{ faultId: 'ACARS-2026-HIST-2', code: 'EGT_EXCEEDANCE_WARN', tail: 'N842UA' }], { 'X-RateLimit-Remaining': '3', 'X-RateLimit-Reset': reset });
    }
    return send(res, 404, { error: 'not found', path: p });
  }).listen(port, '0.0.0.0', () => console.log(`${label} mock MRO listening on http://localhost:${port}`));
}

makeServer(3001, 'primary');
makeServer(3002, 'secondary');
