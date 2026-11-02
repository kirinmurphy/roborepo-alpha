import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

// Create disposable localhost credentials in memory so HTTPS checks need no stored private key
// or external certificate utility. The certificate is deliberately self-signed and untrusted.
export function createLocalTestTls() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // sha256WithRSAEncryption, with the NULL algorithm parameters required by RSA certificates.
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const name = der(0x30, der(0x31, der(0x30, Buffer.concat([
    Buffer.from("0603550403", "hex"), // commonName
    der(0x0c, Buffer.from("localhost")),
  ]))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const now = Date.now();
  const body = der(0x30, Buffer.concat([
    der(0x02, serial),
    algorithm,
    name,
    der(0x30, Buffer.concat([utcTime(now - 60_000), utcTime(now + 3_600_000)])),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  ]));
  const certificate = der(0x30, Buffer.concat([
    body,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", body, privateKey)])),
  ]));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}

function utcTime(timestamp) {
  const time = new Date(timestamp).toISOString().replace(/[-:]/g, "").slice(2, 15).replace("T", "");
  return der(0x17, Buffer.from(`${time}Z`));
}

// DER uses a single length byte below 128, or a byte count followed by the big-endian length.
function der(tag, content) {
  let length = Buffer.from([content.length]);
  if (content.length >= 128) {
    const bytes = [];
    for (let size = content.length; size > 0; size >>>= 8) bytes.unshift(size & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
