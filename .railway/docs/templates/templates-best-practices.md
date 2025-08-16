# Template Best Practices

Creating templates can get complex, but these best practices will help you create templates that are easy to use and maintain.

## Checklist

Depending on the type of template, there are different things to consider:

- [Template and Service Icons](#template-and-service-icons)
- [Naming Conventions](#naming-conventions)
- [Private Networking](#private-networking)
- [Environment Variables](#environment-variables)
- [Health Checks](#health-checks)
- [Persistent Storage](#persistent-storage)
- [Authentication](#authentication)
- [Dry Code](#dry-code)
- [Workspace Naming](#workspace-naming)
- [Overview](#overview)

### Template and Service Icons

Template and service icons are important for branding and recognition, as they give the template a more professional look and feel.

Always use 1:1 aspect ratio icons or logos with transparent backgrounds for both the template itself and the services the template includes.

Transparent backgrounds ensure logos integrate seamlessly with Railway's interface and provide a more polished, professional appearance.

### Naming Conventions

Naming conventions are important for readability and consistency; using proper names enhances the overall quality and credibility of your template.

Always follow the naming conventions for the software that the template is made for.

Example, if the template is for ClickHouse, the service and template name should be named `ClickHouse` with a capital C and H, since that is how the brand name is spelled.

For anything else, such as custom software:

- Use capital case.
- Avoid using special characters or dashes, space-delimited is the way to go.
- Prefer shorter names over longer names for better readability.
- Keep names concise while maintaining clarity.

### Private Networking

Private networking provides faster, free communication between services and reduces costs compared to routing traffic through the public internet.

Always configure service-to-service communication (such as backend to database connections) to use private network hostnames rather than public domains.

For more details, see the [private networking guide](/guides/private-networking) and [reference documentation](/reference/private-networking).

### Environment Variables

Properly set up environment variables are a great way to increase the usability of your template.

When using environment variables:

- Always include