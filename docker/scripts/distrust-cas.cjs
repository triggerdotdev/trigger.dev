const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

const DISTRUSTED = new Map([
  [
    "7D:D7:8D:5F:4F:13:45:9A:83:DF:F9:AB:BB:A6:2E:DB:AF:6F:2D:10:2B:F2:57:FD:71:2F:4D:9F:27:46:ED:8D",
    "emSign Root TLS CA - G3",
  ],
  [
    "F2:ED:AA:FF:3D:9B:70:1F:B4:D1:4C:9F:28:5F:8C:0B:AD:90:FC:3B:CC:1F:A0:7D:47:F4:71:8E:DA:BA:34:A5",
    "emSign Root CS CA - G3",
  ],
  [
    "D7:A7:A0:FB:5D:7E:27:31:D7:71:E9:48:4E:BC:DE:F7:1D:5F:0C:3E:0A:29:48:78:2B:C8:3E:E0:EA:69:9E:F4",
    "AAA Certificate Services",
  ],
  [
    "86:A1:EC:BA:08:9C:4A:8D:3B:BE:27:34:C6:12:BA:34:1D:81:3E:04:3C:F9:E8:A8:62:CD:5C:57:A3:6B:BE:6B",
    "emSign ECC Root CA - G3",
  ],
  [
    "12:56:09:AA:30:1D:A0:A2:49:B9:7A:82:39:CB:6A:34:21:6F:44:DC:AC:9F:39:54:B1:42:92:F2:E8:C8:60:8F",
    "emSign Root CA - C1",
  ],
  [
    "BC:4D:80:9B:15:18:9D:78:DB:3E:1D:8C:F4:F9:72:6A:79:5D:A1:64:3C:A5:F1:35:8E:1D:DB:0E:DC:0D:7E:B3",
    "emSign ECC Root CA - C3",
  ],
]);

tls.setDefaultCACertificates(
  tls
    .getCACertificates("default")
    .filter((pem) => !DISTRUSTED.has(new X509Certificate(pem).fingerprint256))
);
