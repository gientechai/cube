const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer } = require('node:http');

test('multipart boundaries used by request are independent of Math.random', () => {
  const requestTypes = require.resolve('@types/request/package.json');
  const formData = require.resolve('form-data', { paths: [path.dirname(requestTypes)] });
  const FormData = require(formData);
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('predictable randomness was used'); };

  try {
    assert.doesNotThrow(() => new FormData().getBoundary());
  } finally {
    Math.random = originalRandom;
  }
});

test('an IPv4-mapped proxy subnet cannot trust an unrelated client', async () => {
  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.set('trust proxy', '::ffff:10.0.0.0/8');
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));

  const response = await request(app)
    .get('/ip')
    .set('X-Forwarded-For', '198.51.100.99')
    .expect(200);

  assert.notEqual(response.body.ip, '198.51.100.99');
});

test('release template compilation rejects a crafted AST', () => {
  const Handlebars = require('handlebars');
  assert.equal(Handlebars.compile('Release {{version}}')({ version: '1.6.22' }), 'Release 1.6.22');
  const ast = {
    type: 'Program',
    body: [{
      type: 'BlockStatement',
      path: {
        type: 'PathExpression',
        data: false,
        depth: 0,
        parts: ['missingHelper'],
        original: 'missingHelper',
      },
      params: [],
      program: {
        type: 'Program',
        blockParams: { length: '2 + 2' },
        body: [],
      },
      openStrip: { open: false, close: false },
      inverseStrip: { open: false, close: false },
      closeStrip: { open: false, close: false },
    }],
  };

  assert.throws(() => Handlebars.precompile(ast));
});

test('protobuf schema type names cannot contain generated-code punctuation', () => {
  const protobuf = require('protobufjs');
  const message = protobuf.parse('syntax = "proto3"; message Event { string name = 1; }').root.lookupType('Event');
  assert.equal(message.decode(message.encode({ name: 'ready' }).finish()).name, 'ready');
  const type = new protobuf.Type('Unsafe;Name');

  assert.equal(type.name, 'UnsafeName');
});

test('GCS XML parsing keeps escaped markup separate from custom entities', () => {
  const storagePackage = path.dirname(require.resolve('@google-cloud/storage'));
  const xmlParserPath = require.resolve('fast-xml-parser', { paths: [storagePackage] });
  const { XMLParser } = require(xmlParserPath);
  const xml = '<?xml version="1.0"?>\n'
    + '<!DOCTYPE foo [<!ENTITY l. "<img src=x onerror=alert(1)>">]>\n'
    + '<root><text>Hello &lt;b&gt;World&lt;/b&gt;</text></root>';

  assert.equal(new XMLParser().parse(xml).root.text, 'Hello <b>World</b>');
});

test('AWS XML responses keep escaped markup separate from custom entities', () => {
  const { parseXML } = require('@aws-sdk/xml-builder');
  const xml = '<?xml version="1.0"?>\n'
    + '<!DOCTYPE foo [<!ENTITY l. "<img src=x onerror=alert(1)>">]>\n'
    + '<root><text>Hello &lt;b&gt;World&lt;/b&gt;</text></root>';

  assert.equal(parseXML(xml).root.text, 'Hello <b>World</b>');
});

test('Azure XML parsing keeps escaped markup separate from custom entities', () => {
  const azurePackage = path.dirname(require.resolve('@azure/core-xml'));
  const xmlParserPath = require.resolve('fast-xml-parser', { paths: [azurePackage] });
  const { XMLParser } = require(xmlParserPath);
  const xml = '<?xml version="1.0"?>\n'
    + '<!DOCTYPE foo [<!ENTITY l. "<img src=x onerror=alert(1)>">]>\n'
    + '<root><text>Hello &lt;b&gt;World&lt;/b&gt;</text></root>';

  assert.equal(new XMLParser().parse(xml).root.text, 'Hello <b>World</b>');
});

test('Azure XML attributes cannot inject a second attribute when entities are disabled', () => {
  const azurePackage = path.dirname(require.resolve('@azure/core-xml'));
  const builderPath = require.resolve('fast-xml-builder', { paths: [azurePackage] });
  const XMLBuilder = require(builderPath).default;
  const xml = new XMLBuilder({ ignoreAttributes: false, processEntities: false })
    .build({ a: { '@_attr': '" onClick="alert(1)' } });

  assert.equal(xml, '<a attr="&quot; onClick=&quot;alert(1)"></a>');
});

test('driver HTTP responses ignore an inherited JSON reviver', async () => {
  const axios = require('axios');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"role":"user"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'parseReviver');

  try {
    Object.prototype.parseReviver = (key, value) => key === 'role' ? 'admin' : value;
    const { port } = server.address();
    const response = await axios.get(`http://127.0.0.1:${port}/`, { proxy: false });
    assert.deepEqual(response.data, { role: 'user' });
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'parseReviver', original);
    else delete Object.prototype.parseReviver;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('proxy address parsing rejects ambiguous leading-zero IPv4 octets', () => {
  const socksPackage = path.dirname(require.resolve('socks/package.json'));
  const addressPath = require.resolve('ip-address', { paths: [socksPackage] });
  const { Address4 } = require(addressPath);

  assert.throws(() => new Address4('012.0.0.1'));
});

test('proxy address parsing treats NAT64 local-use addresses as private', () => {
  const socksPackage = path.dirname(require.resolve('socks/package.json'));
  const addressPath = require.resolve('ip-address', { paths: [socksPackage] });
  const { Address6 } = require(addressPath);

  assert.equal(new Address6('64:ff9b:1:7f00:0:100::').isPrivate(), true);
});

test('template imports reject code-generating parameter names', () => {
  const lodash = require('lodash');
  const importName = 'helper=(globalThis.__templateInjected=true)';
  try {
    assert.throws(() => lodash.template('safe', { imports: { [importName]: undefined } }));
    assert.equal(globalThis.__templateInjected, undefined);
  } finally {
    delete globalThis.__templateInjected;
  }
});

test('browser cookie attributes cannot be inherited from a JSON prototype key', () => {
  const cookies = require('js-cookie');
  const original = globalThis.document;
  let written = '';
  globalThis.document = {
    get cookie() { return ''; },
    set cookie(value) { written = value; },
  };

  try {
    const attributes = JSON.parse('{"__proto__":{"domain":"evil.example"}}');
    cookies.set('session', 'TOKEN', attributes);
    assert.doesNotMatch(written, /domain=evil\.example/i);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
