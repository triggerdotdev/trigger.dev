import nock from "nock";
import path from "path";
import zlib from "zlib";

nock.back.fixtures = path.join(__dirname, "..", "fixtures");
nock.back.setMode("record");

const makeCompressedResponsesReadable = (scope: any) => {
  if (scope.rawHeaders.indexOf("gzip") > -1) {
    const gzipIndex = scope.rawHeaders.indexOf("gzip");
    scope.rawHeaders.splice(gzipIndex - 1, 2);

    const contentLengthIndex = scope.rawHeaders.indexOf("Content-Length");
    scope.rawHeaders.splice(contentLengthIndex - 1, 2);

    const fullResponseBody =
      scope.response &&
      scope.response.reduce &&
      scope.response.reduce(
        (previous: any, current: any) => previous + current
      );

    try {
      // eslint-disable-next-line no-param-reassign
      scope.response = JSON.parse(
        zlib.gunzipSync(Buffer.from(fullResponseBody, "hex")).toString("utf8")
      );
    } catch (e) {
      // eslint-disable-next-line no-param-reassign
      scope.response = "";
    }
  }
  return scope;
};

const defaultOptions = {
  afterRecord: (outputs: any) => outputs.map(makeCompressedResponsesReadable),
};

export async function startNock(name: string, update = false) {
  if (update) {
    nock.back.setMode("update");
  } else {
    nock.back.setMode("record");
  }
  const { nockDone } = await nock.back(`${name}.json`, defaultOptions);
  return nockDone;
}

export async function stopNock(nockDone: () => void) {
  nockDone();
  nock.back.setMode("wild");
}
