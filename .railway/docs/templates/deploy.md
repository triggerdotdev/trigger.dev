# Deploy a Template

Templates allow you to deploy a fully configured project that is automatically connected to infrastructure.

You can find featured templates on the [template marketplace](https://railway.com/templates).

## Template Deployment Flow

To deploy a template:

- Find a template from the marketplace and click `Deploy Now`
- If necessary, configure the required variables, and click `Deploy`
- Upon deploy, you will be taken to your new project containing the template service(s)
  - Services are deployed directly from the defined source in the template configuration
  - After deploy, you can find the service source by going to the service's settings tab
  - Should you need to make changes to the source code, you will need to [eject from the template repo](#eject-from-template-repository) to create your own copy

*Note: You can also deploy templates into existing projects, by clicking `+ New` from your project canvas and selecting `Template`.*

## Eject from Template Repository

> As of March 2024, the default behavior for deploying templates is to attach to and deploy directly from the template repository.

By default, services deployed from a template are attached to and deployed directly from the template repository. In some cases, you may want to have your own copy of the template repository.

Follow these steps to eject from the template repository and create a mirror in your own GitHub account:

1. In the [service settings](/overview/the-basics#service-settings), under Source, find the **Upstream Repo** setting
2. Click the `Eject` button
3. Select the appropriate GitHub organization to create the new repository
4. Click `Eject service`

## Updatable Templates

When you deploy services from a template based on a GitHub repo, Railway will check if the project has been updated by its creator every time you visit the project.

If an upstream update is available, Railway will:
- Create a branch on the GitHub repo
- Allow you to test changes within a PR deploy

If you're satisfied with the changes:
- Merge the pull request
- Railway will automatically deploy to your production environment

Read more about updatable templates in the [Railway blog post](https://blog.railway.com/p/updatable-starters).

*Note: This feature only works for services based on GitHub repositories. Docker image updates are not currently