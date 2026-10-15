import { readFileSync } from "node:fs";
import https from "node:https";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

// Minimal in-cluster Kubernetes API client; workspaced needs a handful of CRUD
// calls, which does not justify a client library dependency.
export function inClusterKube({ host = process.env.KUBERNETES_SERVICE_HOST, port = process.env.KUBERNETES_SERVICE_PORT || "443" } = {}) {
  if (!host) throw new Error("KUBERNETES_SERVICE_HOST is not set; workspaced must run in-cluster");
  const ca = readFileSync(`${SA_DIR}/ca.crt`);
  return {
    request(method, path, body, contentType = "application/json") {
      // Projected tokens rotate; re-read per request.
      const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
      const payload = body === undefined ? null : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = https.request({
          host, port, path, method, ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(payload ? { "content-type": contentType, "content-length": Buffer.byteLength(payload) } : {}),
          },
          timeout: 15_000,
        }, res => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", chunk => { data += chunk; });
          res.on("end", () => {
            let json = null;
            try { json = data ? JSON.parse(data) : null; } catch { json = { message: data.slice(0, 500) }; }
            resolve({ status: res.statusCode, body: json });
          });
        });
        req.on("timeout", () => req.destroy(new Error("kubernetes api timeout")));
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
