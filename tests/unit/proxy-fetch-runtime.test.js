import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { connect } from "node:net";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const requests = [];
const tunnels = new Set();
let upstream, proxy, origin, proxyUrl;

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString(), path: req.url });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${upstream.address().port}`;
  proxy = createServer();
  proxy.on("connect", (req, socket) => {
    // The fixture can only tunnel to its own loopback upstream.
    if (req.url !== `127.0.0.1:${upstream.address().port}`) return socket.destroy();
    const target = connect(upstream.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(target).pipe(socket);
    });
    for (const stream of [socket, target]) {
      tunnels.add(stream);
      stream.on("error", () => stream.destroy());
      stream.on("close", () => tunnels.delete(stream));
    }
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

afterAll(async () => {
  for (const socket of tunnels) socket.destroy();
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

describe("undici 8 through the actual proxy transport", () => {
  it.each([false, true])("sends native multipart with per-request timeouts, proxy=%s", async (proxied) => {
    const body = new FormData();
    body.append("model", "fixture");
    body.append("file", new Blob(["audio-fixture"], { type: "audio/wav" }), "input.wav");
    const before = requests.length;
    const result = await proxyAwareFetch(`${origin}/transcribe`, {
      method: "POST", body, headersTimeout: 30000, bodyTimeout: 30000,
    }, proxied
      ? { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl, strictProxy: true, proxyRequired: true, useEnvProxy: false }
      : { useEnvProxy: false });
    expect(await result.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(before + 1);
    expect(requests.at(-1).headers["content-type"]).toContain("multipart/form-data;");
    expect(requests.at(-1).body).toContain('filename="input.wav"');
    expect(requests.at(-1).body).toContain("audio-fixture");
  });

  it("keeps relay routing headers and scoped dispatcher timeouts", async () => {
    const result = await proxyAwareFetch("https://fixture.invalid/v1/responses?mode=test", {
      method: "POST", body: "{}", headersTimeout: 30000, bodyTimeout: 30000,
    }, { vercelRelayUrl: `${origin}/relay`, useEnvProxy: false });
    expect(await result.json()).toEqual({ ok: true });
    expect(requests.at(-1)).toMatchObject({ path: "/relay", headers: {
      "x-relay-target": "https://fixture.invalid", "x-relay-path": "/v1/responses?mode=test",
    } });
  });
});
