# Create a Template

Creating a template allows you to capture your infrastructure in a reusable and distributable format.

By defining services, environment configuration, network settings, etc., you lay the foundation for others to deploy the same software stack with the click of a button.

If you [publish your template](/guides/publish-and-share) to the [marketplace](https://railway.com/templates), you can even [collect a kickback](https://railway.com/open-source-kickback) from the usage of it!

## How to Create a Template

You can either create a template from scratch or base it off of an existing project.

### Starting from Scratch

To create a template from scratch, head over to the [template composer](https://railway.com/compose) then add and configure your services:

- Add a service by clicking the `Add New` button in the top right-hand corner, or through the command palette (`CMD + K` -> `+ New Service`)
- Select the service source (GitHub repo or Docker Image)
- Configure the service variables and settings
- Once you've added your services, click `Create Template`
- You will be taken to your templates page where you can copy the template URL to share with others

Note that your template will not be available on the template marketplace, nor will be eligible for a kickback, until you [publish](/guides/publish-and-share) it.

### Private Repo Support

It's now possible to specify a private GitHub repo when creating a template.

This feature is intended for use among [Teams](/reference/teams) and [Organizations](/reference/teams). Users supporting a subscriber base may also find this feature helpful to distribute closed-source code.

To deploy a template that includes a private repo, look for the `GitHub` panel in the `Account Integrations` section of [General Settings](https://railway.com/account). Then select the `Edit Scope` option to grant Railway access to the desired private repos.

If you do not see the `Edit Scope` option, you may still need to connect GitHub to your Railway account.

### Convert a Project Into a Template

You can also convert an existing project into a ready-made Template for other users:

- From your project page, click `Settings` in the right-hand corner of the canvas
- Scroll down until you see **Generate Template from