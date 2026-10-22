import http2 from "http2";
import WebSocket from "ws";

const CONFIG = {
  host: 'https://canary.discord.com',
  token: "",
  serverID: "",
  logChannel: "",
  password: "",
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  superProps: 'eyJvcyI6IkFuZHJvaWQiLCJicm93c2VyIjoiQW5kcm9pZCBDaHJvbWUiLCJkZXZpY2UiOiJBbmRyb2lkIiwic3lzdGVtX2xvY2FsZSI6InRyLVRSIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKExpbnV4OyBBbmRyb2lkIDYuMDsgTmV4dXMgNSBCdWlsZC9NUkE1OE4pIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xMzEuMC4wLjAgTW9iaWxlIFNhZmFyaS81MzcuMzYiLCJicm93c2VyX3ZlcnNpb24iOiIxMzEuMC4wLjAiLCJvc192ZXJzaW9uIjoiNi4wIiwicmVmZXJyZXIiOiJodHRwczovL2Rpc2NvcmQuY29tL2NoYW5uZWxzL0BtZS8xMzAzMDQ1MDIyNjQzNTIzNjU1IiwicmVmZXJyaW5nX2RvbWFpbiI6ImRpc2NvcmQuY29tIiwicmVmZXJyaW5nX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJzdGFibGUiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTU2MjQsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9='
};

let mfaToken = "";
const targetGuilds = [];
let client = null;
let seq = null;
let sessionId = null;
let resumeUrl = null;
let heartbeatTimer = null;
let wsInstance = null;
let heartbeatAcked = true;
let wsConnecting = false;
let authRenewing = false;

const createHttp2Client = () => {
  if (client && !client.destroyed) {
    try { client.close(); } catch {}
    try { client.destroy(); } catch {}
  }
  client = http2.connect(CONFIG.host);
  client.on('error', () => {
    setTimeout(reconnectHttp2, 2000);
  });
  client.on('goaway', () => {
    setTimeout(reconnectHttp2, 1000);
  });
};

const reconnectHttp2 = () => {
  createHttp2Client();
};

const getHeaders = (method, path) => {
  const h = {
    ':method': method,
    ':path': path,
    ':scheme': 'https',
    ':authority': 'canary.discord.com',
    'authorization': CONFIG.token,
    'user-agent': CONFIG.userAgent,
    'x-super-properties': CONFIG.superProps,
    'content-type': 'application/json',
  };
  if (mfaToken) h['x-discord-mfa-authorization'] = mfaToken;
  return h;
};

const sendRequest = (method, path, body = null) => {
  return new Promise((resolve, reject) => {
    if (!client || client.destroyed || client.closed) {
      reconnectHttp2();
      reject(new Error('http2 client not available'));
      return;
    }
    try {
      const req = client.request(getHeaders(method, path));
      let data = '';
      req.setTimeout(10000, () => {
        req.close();
        reject(new Error('request timeout'));
      });
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
      if (body) req.end(body);
      else req.end();
    } catch (e) {
      reject(e);
    }
  });
};

const logToDiscord = (msg) => {
  if (!client || client.destroyed || client.closed) return;
  try {
    const req = client.request(getHeaders('POST', `/api/v9/channels/${CONFIG.logChannel}/messages`));
    req.on('error', () => {});
    req.on('response', () => {});
    req.on('data', () => {});
    req.on('end', () => {});
    req.end(JSON.stringify({ content: msg }));
  } catch {}
};

const completeAuth = async (ticket, pendingCode) => {
  try {
    const response = await sendRequest(
      "POST",
      "/api/v9/mfa/finish",
      JSON.stringify({
        ticket,
        mfa_type: "password",
        data: CONFIG.password
      })
    );

    let parsed;
    try { parsed = JSON.parse(response); } catch { return; }

    if (parsed && parsed.token) {
      mfaToken = parsed.token;
      console.log("Auth renewed");
      if (pendingCode) claimVanity(pendingCode);
    } else {
      logToDiscord(`Auth renew failed: ${JSON.stringify(parsed)}`);
    }
  } catch {}
};

const renewAuthToken = async () => {
  if (authRenewing) return;
  authRenewing = true;
  try {
    const response = await sendRequest(
      "PATCH",
      `/api/v9/guilds/${CONFIG.serverID}/vanity-url`,
      JSON.stringify({ code: `token-renew-${Date.now()}` })
    );

    let parsed;
    try { parsed = JSON.parse(response); } catch { return; }

    if (parsed && parsed.code === 60003 && parsed.mfa && parsed.mfa.ticket) {
      await completeAuth(parsed.mfa.ticket, null);
    }
  } catch {} finally {
    authRenewing = false;
  }
};

setInterval(() => {
  renewAuthToken();
}, 5 * 60 * 1000);

const claimVanity = (code) => {
  if (!client || client.destroyed || client.closed) {
    reconnectHttp2();
    return;
  }
  const body = JSON.stringify({ code });
  for (let i = 0; i < 2; i++) {
    try {
      const start = process.hrtime.bigint();
      const req = client.request(getHeaders('PATCH', `/api/v9/guilds/${CONFIG.serverID}/vanity-url`));
      let responseBody = '';
      let statusCode = 0;
      req.on('response', (resHeaders) => {
        statusCode = resHeaders[':status'];
        const took = (Number(process.hrtime.bigint() - start) / 1000000).toFixed(2);
        console.log(`[${code}] ${took}ms | ${statusCode}`);
        if (statusCode === 200 || statusCode === 204) {
          logToDiscord(`@everyone ${code} claimed | Took: ${took}ms`);
        }
      });
      req.on('data', (chunk) => { responseBody += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (parsed && parsed.code === 60003 && parsed.mfa && parsed.mfa.ticket) {
            completeAuth(parsed.mfa.ticket, code);
          } else if (statusCode === 401) {
            renewAuthToken();
          }
        } catch {}
      });
      req.on('error', () => {});
      req.end(body);
    } catch {}
  }
};

const connectWS = (resume = false) => {
  if (wsConnecting) return;
  wsConnecting = true;

  if (wsInstance) {
    try { wsInstance.removeAllListeners(); wsInstance.close(); } catch {}
    wsInstance = null;
  }

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const gatewayUrl = (resume && resumeUrl) ? `${resumeUrl}/?v=9&encoding=json` : "wss://gateway.discord.gg/?v=9&encoding=json";

  const ws = new WebSocket(gatewayUrl, {
    perMessageDeflate: false,
    headers: { 'User-Agent': CONFIG.userAgent }
  });
  wsInstance = ws;

  ws.on('open', () => {
    wsConnecting = false;
    if (ws._socket) {
      ws._socket.setNoDelay(true);
      ws._socket.setKeepAlive(true, 5000);
    }

    if (resume && sessionId && seq !== null) {
      ws.send(JSON.stringify({
        op: 6,
        d: {
          token: CONFIG.token,
          session_id: sessionId,
          seq: seq
        }
      }));
    } else {
      seq = null;
      sessionId = null;
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: CONFIG.token,
          intents: 1,
          properties: { os: "Windows", browser: "Chrome", device: "" }
        }
      }));
    }
  });

  ws.on('message', (data) => {
    let packet;
    try { packet = JSON.parse(data.toString()); } catch { return; }

    if (packet.s != null) seq = packet.s;

    if (packet.op === 10 && packet.d) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatAcked = true;
      const interval = packet.d.heartbeat_interval;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: seq }));
        }
      }, Math.floor(interval * Math.random()));
      heartbeatTimer = setInterval(() => {
        if (!heartbeatAcked) {
          ws.close(4000);
          return;
        }
        heartbeatAcked = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: seq }));
        }
      }, interval);
      return;
    }

    if (packet.op === 11) {
      heartbeatAcked = true;
      return;
    }

    if (packet.op === 1) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 1, d: seq }));
      }
      return;
    }

    if (packet.op === 7) {
      ws.close(4000);
      return;
    }

    if (packet.op === 9) {
      const canResume = packet.d === true;
      sessionId = canResume ? sessionId : null;
      seq = canResume ? seq : null;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close(4000);
      }, 1000 + Math.random() * 4000);
      return;
    }

    if (packet.t === "READY" && packet.d) {
      sessionId = packet.d.session_id || null;
      resumeUrl = packet.d.resume_gateway_url || null;
      targetGuilds.length = 0;
      if (packet.d.guilds) {
        for (const g of packet.d.guilds) {
          if (!g.vanity_url_code) continue;
          targetGuilds.push({
            guildId: g.id,
            vanity: g.vanity_url_code,
          });
        }
      }
      console.log(`Ready | Tracking ${targetGuilds.length} guilds with vanity URLs`);
      renewAuthToken();
      return;
    }

    if (packet.t === "RESUMED") {
      console.log("Resumed successfully");
      return;
    }

    if (packet.t === "GUILD_UPDATE" && packet.d) {
      const guildId = packet.d.id;
      const newVanity = packet.d.vanity_url_code || null;
      for (let i = 0; i < targetGuilds.length; i++) {
        const tg = targetGuilds[i];
        if (tg.guildId === guildId) {
          if (newVanity !== tg.vanity) {
            const oldVanity = tg.vanity;
            tg.vanity = newVanity;
            if (oldVanity) {
              console.log(`GUILD_UPDATE | ${oldVanity} -> ${newVanity || "none"} | guild: ${guildId}`);
              claimVanity(oldVanity);
            }
          }
          return;
        }
      }
      if (newVanity) {
        targetGuilds.push({ guildId, vanity: newVanity });
      }
      return;
    }

    if (packet.t === "GUILD_DELETE" && packet.d) {
      const guildId = packet.d.id;
      for (let i = 0; i < targetGuilds.length; i++) {
        const tg = targetGuilds[i];
        if (tg.guildId === guildId) {
          if (tg.vanity && !packet.d.unavailable) {
            console.log(`GUILD_DELETE | ${tg.vanity} | guild: ${guildId}`);
            claimVanity(tg.vanity);
          }
          targetGuilds.splice(i, 1);
          return;
        }
      }
      return;
    }

    if (packet.t === "GUILD_CREATE" && packet.d) {
      if (packet.d.vanity_url_code) {
        const existing = targetGuilds.find(tg => tg.guildId === packet.d.id);
        if (!existing) {
          targetGuilds.push({ guildId: packet.d.id, vanity: packet.d.vanity_url_code });
        } else {
          existing.vanity = packet.d.vanity_url_code;
        }
      }
      return;
    }
  });

  ws.on('close', (code) => {
    wsConnecting = false;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    heartbeatAcked = true;

    if (code === 4004) {
      console.log("Invalid token");
      setTimeout(() => connectWS(false), 60000);
    } else if (code === 4014 || code === 4011 || code === 4012 || code === 4013) {
      console.log(`Fatal close code: ${code}`);
      sessionId = null;
      seq = null;
      setTimeout(() => connectWS(false), 5000);
    } else if (sessionId && seq !== null) {
      setTimeout(() => connectWS(true), 1000);
    } else {
      setTimeout(() => connectWS(false), 2000);
    }
  });

  ws.on('error', () => {
    wsConnecting = false;
  });
};

createHttp2Client();

setInterval(() => {
  if (!client || client.destroyed || client.closed) {
    reconnectHttp2();
    return;
  }
  try {
    const req = client.request({
      ':method': 'GET',
      ':path': '/api/v9/users/@me',
      ':scheme': 'https',
      ':authority': 'canary.discord.com',
      'authorization': CONFIG.token
    });
    req.on('data', () => {});
    req.on('error', () => { reconnectHttp2(); });
    req.on('end', () => {});
    req.setTimeout(10000, () => { req.close(); reconnectHttp2(); });
    req.end();
  } catch {
    reconnectHttp2();
  }
}, 30000);

connectWS(false);
