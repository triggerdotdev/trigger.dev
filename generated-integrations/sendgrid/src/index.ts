import { getTriggerRun } from "@trigger.dev/sdk";
import { MailSendInput } from "./types";

/** The Mail Send endpoint allows you to send email over SendGrid’s v3 Web API, the most recent version of our API. If you are looking for documentation about the v2 Mail Send endpoint, see our [v2 API Reference](https://sendgrid.com/docs/API_Reference/Web_API/mail.html).

## Helper Libraries

Twilio SendGrid provides libraries to help you quickly and easily integrate with the v3 Web API in 7 different languages:

* [C#](https://github.com/sendgrid/sendgrid-csharp) 
* [Go](https://github.com/sendgrid/sendgrid-go)
* [Java](https://github.com/sendgrid/sendgrid-java)
* [Node JS](https://github.com/sendgrid/sendgrid-nodejs)
* [PHP](https://github.com/sendgrid/sendgrid-php)
* [Python](https://github.com/sendgrid/sendgrid-python)
* [Ruby](https://github.com/sendgrid/sendgrid-ruby)

## Dynamic Transactional Templates and Handlebars

In order to send a dynamic template, specify the template ID with the `template_id` parameter. 

To specify handlebar substitutions, define your substitutions in the request JSON with this syntax:

```
"dynamic_template_data": {
      "guest": "Jane Doe",
      "partysize": "4",
      "english": true,
      "date": "April 1st, 2021"
    }
```

For more information about Dynamic Transactional Templates and Handlebars, see our documentation and reference pages.

* [How to send an email with Dynamic Transactional Templates
](https://sendgrid.com/docs/ui/sending-email/how-to-send-an-email-with-dynamic-transactional-templates/)
* [Using Handlebars](https://sendgrid.com/docs/for-developers/sending-email/using-handlebars/) 

## Mail Body Compression

Mail body compression is available to some high volume accounts. Talk to your CSM if you are interested in this functionality. Mail body compression works by setting up a JSON payload as defined on this page, then compressing it with gzip (the gzip file can be no more than 30mb).

To use mail body compression:

1. Add a `Content-Encoding` header, with a value of `gzip`.  
   a. `Content-Encoding: gzip` 
2. Send the gzip as a data-binary.  
   a. `--data-binary '@data.json.gz'
`

## Multiple Reply-To Emails

Using `reply_to_list` allows senders to include more than one recipient email address to receive reply and/or bounce messages from the recipient of the email.

### Usage Considerations

* `reply_to` is mutually exclusive with `reply_to_list`. If both are used, then the API call will be rejected. 
* The `reply_to_list` object, when used, must at least have an email parameter and may also contain a name parameter.
* Each email address in the `reply_to_list` should be unique.
* There is a limit of 1000 `reply_to_list` emails per mail/send request.
* In SMTP calls, we will omit any invalid emails.

### Possible 400 Error Messages

* `reply_to` is mutually exclusive with `reply_to_list`.
* The `reply_to_list` object, when used, must at least have an email parameter and may also contain a name parameter.
* Each email address in the `reply_to_list` should be unique.
* There is a limit of X `reply_to` emails per mail/send request.
* The `reply_to_list` email does not contain a valid address.
* The `reply_to_list` email exceeds the maximum total length of X characters.
* The `reply_to_list` email parameter is required. */
export async function mailSend(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: MailSendInput
): Promise<void> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call mailSend outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "sendgrid",
    endpoint: "mailSend",
    params,
  });

  return output;
}
