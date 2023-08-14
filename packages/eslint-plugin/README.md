# @trigger.dev/eslint-plugin

ESLint plugin with trigger.dev best practices

## Installation

You'll first need to install [ESLint](https://eslint.org/):

```sh
npm i eslint --save-dev
```

Next, install `@trigger.dev/eslint-plugin`:

```sh
npm install @trigger.dev/eslint-plugin --save-dev
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

| Name                                                             | Description                                      |
| :--------------------------------------------------------------- | :----------------------------------------------- |
| [no-duplicated-task-keys](docs/rules/no-duplicated-task-keys.md) | Prevent duplicated task keys on trigger.dev jobs |

<!-- end auto-generated rules list -->


