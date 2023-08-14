# eslint-plugin-trigger-dev

ESLint plugin with trigger.dev best practices

## Installation

You'll first need to install [ESLint](https://eslint.org/):

```sh
npm i eslint --save-dev
```

Next, install `eslint-plugin-trigger-dev`:

```sh
npm install eslint-plugin-trigger-dev --save-dev
```

## Usage

Add `trigger-dev` to the plugins section of your `.eslintrc` configuration file. You can omit the `eslint-plugin-` prefix:

```json
{
    "plugins": [
        "trigger-dev"
    ]
}
```


Then configure the rules you want to use under the rules section.

```json
{
    "rules": {
        "trigger-dev/rule-name": 2
    }
}
```

## Rules

<!-- begin auto-generated rules list -->
TODO: Run eslint-doc-generator to generate the rules list.
<!-- end auto-generated rules list -->


