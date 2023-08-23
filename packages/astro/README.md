# Trigger.dev native integration add-on for Astro

This Astro integration project provides a `createAstroRoute` function that can be used to create an API endpoint route in your Astro project for integration with the hosted Trigger.dev platform.

## Usage

1. Install the package:

```bash
npm install --save @trigger.dev/astro
```

Note: yes, right now this package isn't published to the npm registry, so you'll need to install it from my GitHub repository if you want to experiment with it. Hopefully this soon graduates into an official npm package from the Trigger.dev team 🙏🏼

2. Import the package in a `src/pages/api/trigger.js` file and define the route endpoint as follows:

```js
import { createAstroRoute } from "triggerdev-astro-integration";
import { client } from "../../../trigger.js";

export const post = createAstroRoute(client);
```

## More information

See the [Trigger.dev Astro example project repository](https://github.com/lirantal/trigger.dev-astro-example) for a working example of this integration.

## License

MIT

## Author

(c) Liran Tal <liran@lirantal.com>