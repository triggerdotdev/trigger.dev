# Third-party attribution

The bundled provider samples in `src/generated/hookdeck-samples.json` are ingested from the
[Hookdeck webhook-samples](https://github.com/hookdeck/webhook-samples) dataset, which is licensed
under the MIT License.

The event bodies are normalized (transport and signature headers stripped, routing headers kept)
into this package's `SampleRecord` shape by `src/ingest.ts`. Signatures are not stored; the console
signs each body with the target endpoint's own config at send time.

To refresh the snapshot, run `pnpm run ingest`.
