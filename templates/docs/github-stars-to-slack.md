### 🚀 Installation

This is the Github stars to slack trigger.dev template

```
npm i -g mintlify
```

### 👩‍💻 Development

Run the following command at the root of your Mintlify application to preview changes locally.

```
mintlify dev
```

Note - `mintlify dev` requires `yarn` and it's recommended you install it as a global installation. If you don't have yarn installed already run `npm install --global yarn` in your terminal.

### Custom Ports

Mintlify uses port 3000 by default. You can use the `--port` flag to customize the port Mintlify runs on. For example, use this command to run in port 3333:

```
mintlify dev --port 3333
```

You will see an error like this if you try to run Mintlify in a port that's already taken:

```
Error: listen EADDRINUSE: address already in use :::3000
```
