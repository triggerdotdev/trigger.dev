import { customEvent, Trigger } from "@trigger.dev/sdk";
import * as slack from "@trigger.dev/slack";
import JSXSlack, {
  Actions,
  Blocks,
  Button,
  Checkbox,
  CheckboxGroup,
  DatePicker,
  DateTimePicker,
  Divider,
  Input,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Section,
  Select,
  Option,
  Textarea,
  TimePicker,
  Context,
  Image,
  Field,
  Header,
  Overflow,
  OverflowItem,
} from "jsx-slack";
import { z } from "zod";

const IssueBlockID = "issue.action";

new Trigger({
  id: "slack-modals",
  name: "Initial Slack Modal Flow",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({ name: "slack.modal.initiate", schema: z.any() }),
  run: async (event, ctx) => {
    await slack.postMessage("jsx-test", {
      channelName: "test-integrations",
      //text appears in Slack notifications on mobile/desktop
      text: "New github issue",
      //import and use JSXSlack to make creating rich messages much easier
      blocks: JSXSlack(
        <Blocks>
          <Section>New GitHub Issue, would you like to reply?</Section>
          <Actions blockId={IssueBlockID}>
            <Button value="issue_1234" actionId="reply-to-issue">
              Reply
            </Button>
            <Button value="issue_1234" actionId="close-issue">
              Close
            </Button>
          </Actions>
        </Blocks>
      ),
    });
  },
}).listen();

new Trigger({
  id: "slack-modals-initiate-reply",
  name: "Slack Modals Initiate Reply",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.blockActionInteraction({
    blockId: IssueBlockID,
    actionId: ["reply-to-issue", "close-issue"],
  }),
  run: async (event, ctx) => {
    //create promises from all the actions
    const promises = event.actions.map(async (action) => {
      switch (action.action_id) {
        case "reply-to-issue": {
          // Use the trigger_id to open a modal
          await ctx.logger.info(`Replying to issue ${action.action_ts}`, {
            action,
          });

          if (event.trigger_id) {
            const response = await slack.openView(
              `Opening modal for ${action.action_ts}`,
              event.trigger_id,
              JSXSlack(
                <Modal
                  title="My first modal"
                  close="Cancel"
                  callbackId="reply-to-issue-modal"
                >
                  <Section>
                    <p>
                      <strong>It's my first modal!</strong> :sunglasses:
                    </p>
                    <p>jsx-slack also has supported Slack Modals.</p>
                  </Section>
                  <Divider />

                  <Actions id="view-interaction">
                    <Button value="push" actionId="push">
                      Push View
                    </Button>
                    <Button value="update" actionId="update">
                      Update view
                    </Button>
                  </Actions>

                  <Input
                    name="name"
                    label="Name"
                    maxLength={50}
                    id="nameField"
                    placeholder="Your name"
                    required
                  />

                  <Textarea
                    name="message"
                    label="Message"
                    placeholder="Your message"
                    maxLength={500}
                    id="messageField"
                  />

                  <DatePicker
                    name="closeAt"
                    label="Close At"
                    id="closeAtField"
                    initialDate={new Date(Date.now() + 1000 * 60 * 60 * 24)}
                  />

                  <TimePicker
                    name="remindMeAtTime"
                    label="Remind me at"
                    id="remindMeAtTimeField"
                  />

                  <DateTimePicker
                    name="issueAt"
                    label="Issue At"
                    id="issueAtField"
                  />

                  <Input type="hidden" name="postId" value="xxxx" />
                  <Input type="submit" value="Send" />
                </Modal>
              ),
              {
                validationSchema: z.object({
                  nameField: z.string().min(3),
                  issueAtField: z.string().datetime(),
                }),
              }
            );

            await ctx.logger.info("Modal response", { response });
          }

          break;
        }
        case "close-issue": {
          // Use the trigger_id to open a modal
          await ctx.logger.info(`Closing issue ${action.action_ts}`, {
            action,
          });
          break;
        }

        default:
          return Promise.resolve();
      }
    });

    await Promise.all(promises);
  },
}).listen();

new Trigger({
  id: "slack-modals-block-actions-in-view",
  name: "Slack Modals Block Actions in View",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.blockActionInteraction({
    blockId: "view-interaction",
  }),
  run: async (event, ctx) => {
    const action = event.actions[0];

    await ctx.logger.info("View interaction", { action });

    if (!event.trigger_id) {
      return;
    }

    // We should be able to update the view, or push a new modal

    if (action.action_id === "push") {
      await slack.pushView(
        "Pushing view",
        event.trigger_id,
        JSXSlack(
          <Modal
            title="My pushed modal"
            close="Cancel"
            callbackId="reply-to-issue-modal3"
          >
            <Section>
              <p>
                <strong>This is an pushed model!</strong>
              </p>
            </Section>
            <Divider />

            <CheckboxGroup
              id="anotherField"
              name="anotherInput"
              label="Should we actually close this view"
              required
            >
              <Checkbox value="yes">Yes Please :hamburger:</Checkbox>
              <Checkbox value="no">No keep it going :pizza:</Checkbox>
            </CheckboxGroup>

            <Input type="submit" value="Send" />
          </Modal>
        ),
        {
          onSubmit: "close",
        }
      );
    } else if (event.view) {
      await slack.updateView(
        "Updating view",
        event.view,
        JSXSlack(
          <Modal
            title="My first modal"
            close="Cancel"
            callbackId="reply-to-issue-modal2"
          >
            <Section>
              <p>
                <strong>This is an updated model!</strong>
              </p>
            </Section>
            <Divider />

            <CheckboxGroup
              id="foodsField"
              name="foods"
              label="What do you want to eat for the party in this Friday?"
              required
            >
              <Checkbox value="burger">Burger :hamburger:</Checkbox>
              <Checkbox value="pizza">Pizza :pizza:</Checkbox>
              <Checkbox value="taco">Tex-Mex taco :taco:</Checkbox>
              <Checkbox value="sushi">Sushi :sushi:</Checkbox>
            </CheckboxGroup>

            <Input type="submit" value="Send" />
          </Modal>
        ),
        {
          onSubmit: "clear",
        }
      );
    }
  },
}).listen();

new Trigger({
  id: "slack-modals-handle-reply-update",
  name: "Slack Modals Handle Reply Update",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.viewSubmissionInteraction({
    callbackId: "reply-to-issue-modal2",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Modal submission", { event });

    return event;
  },
}).listen();

new Trigger({
  id: "send-slack-modal-catalog-message",
  name: "Send Slack Modal Catalog Message",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "slack.modal.catalog",
    schema: z.any(),
  }),
  run: async (event, ctx) => {
    await slack.postMessage("Send Modal Catalog Message", {
      channelName: "test-integrations",
      text: "Select a modal to open",
      blocks: JSXSlack(
        <Blocks>
          <Section>Which modal would you like to test?</Section>
          <Actions blockId="modal-catalog">
            <Button value="poll" actionId="poll">
              Poll
            </Button>
            <Button value="searchResults" actionId="searchResults">
              Search Results
            </Button>

            <Button value="appMenu" actionId="appMenu">
              App Menu (Settings)
            </Button>

            <Button
              value="notificationSettings"
              actionId="notificationSettings"
            >
              Notification Settings
            </Button>

            <Button value="yourItinerary" actionId="yourItinerary">
              Your Itinerary
            </Button>

            <Button value="ticketApp" actionId="ticketApp">
              Ticket App
            </Button>
          </Actions>
        </Blocks>
      ),
    });
  },
}).listen();

new Trigger({
  id: "slack-modal-catalog-block-interaction",
  name: "Slack Modal Catalog Handle Block Interaction",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.blockActionInteraction({
    blockId: "modal-catalog",
  }),
  run: async (event, ctx) => {
    if (!event.trigger_id) {
      await ctx.logger.error("No trigger_id", { event });
      return;
    }

    const action = event.actions[0];

    switch (action.action_id) {
      case "poll": {
        await slack.openView("Opening view", event.trigger_id, PollModal, {
          onSubmit: "close",
        });
        break;
      }
      case "searchResults": {
        await slack.openView(
          "Opening view",
          event.trigger_id,
          SearchResultsModal,
          {
            onSubmit: "close",
          }
        );
        break;
      }
      case "appMenu": {
        await slack.openView("Opening view", event.trigger_id, AppMenuModal, {
          onSubmit: "close",
        });
        break;
      }
      case "notificationSettings": {
        await slack.openView(
          "Opening view",
          event.trigger_id,
          NotificationSettingsModal,
          {
            onSubmit: "close",
          }
        );
        break;
      }
      case "yourItinerary": {
        await slack.openView(
          "Opening view",
          event.trigger_id,
          YourItineraryModal,
          {
            onSubmit: "close",
          }
        );
        break;
      }
      case "ticketApp": {
        await slack.openView("Opening view", event.trigger_id, TicketAppModal, {
          onSubmit: "close",
        });
        break;
      }
    }
  },
}).listen();

new Trigger({
  id: "slack-modals-handle-catalog-submission",
  name: "Slack Modals Handle Catalog Submission",
  apiKey: "trigger_development_GJE9dEaqhqes",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: slack.events.viewSubmissionInteraction({
    callbackId: "modal-catalog-submission",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("Modal submission", { event });

    return event;
  },
}).listen();

const PollModal = JSXSlack(
  <Modal
    title="Workplace check-in"
    close="Cancel"
    callbackId="modal-catalog-submission"
  >
    <Section>
      <p>:wave: Hey David!</p>
      <p>
        We'd love to hear from you how we can make this place the best place
        you’ve ever worked.
      </p>
    </Section>
    <Divider />

    <RadioButtonGroup label="You enjoy working here at Pistachio & Co" required>
      <RadioButton value="1">Strongly agree</RadioButton>
      <RadioButton value="2">Agree</RadioButton>
      <RadioButton value="3">Neither agree nor disagree</RadioButton>
      <RadioButton value="4">Disagree</RadioButton>
      <RadioButton value="5">Strongly disagree</RadioButton>
    </RadioButtonGroup>

    <Select
      label="What do you want for our team weekly lunch?"
      placeholder="Select your favorites"
      multiple
      required
    >
      <Option value="value-0">:pizza: Pizza</Option>
      <Option value="value-1">:fried_shrimp: Thai food</Option>
      <Option value="value-2">:desert_island: Hawaiian</Option>
      <Option value="value-3">:meat_on_bone: Texas BBQ</Option>
      <Option value="value-4">:hamburger: Burger</Option>
      <Option value="value-5">:taco: Tacos</Option>
      <Option value="value-6">:green_salad: Salad</Option>
      <Option value="value-7">:stew: Indian</Option>
    </Select>

    <Textarea
      label="What can we do to improve your experience working here?"
      required
    />
    <Textarea label="Anything else you want to tell us?" />
  </Modal>
);

const SearchResultsModal = JSXSlack(
  <Modal
    title="Your accommodation"
    close="Cancel"
    callbackId="modal-catalog-submission"
  >
    <Section>
      Please choose an option where you'd like to stay from Oct 21 - Oct 23 (2
      nights).
    </Section>
    <Divider />
    <Section>
      <b>Airstream Suite</b>
      <br />
      <b>Share with another person</b>. Private walk-in bathroom. TV. Heating.
      Kitchen with microwave, basic cooking utensils, wine glasses and
      silverware.
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/Streamline-Beach.png"
        alt="Airstream Suite"
      />
    </Section>
    <Context>
      1x Queen Bed
      <span>|</span>
      $220 / night
    </Context>
    <Actions>
      <Button value="click_me_123">Choose</Button>
      <Button value="click_me_123">View Details</Button>
    </Actions>
    <Divider />
    <Section>
      <b>Redwood Suite</b>
      <br />
      <b>Share with 2 other person</b>. Studio home. Modern bathroom. TV.
      Heating. Full kitchen. Patio with lounge chairs and campfire style fire
      pit and grill.
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/redwoodcabin.png"
        alt="Redwood Suite"
      />
    </Section>
    <Context>
      1x King Bed
      <span>|</span>
      $350 / night
    </Context>
    <Actions>
      <Button value="click_me_123" style="primary">
        ✓ Your Choice
      </Button>
      <Button value="click_me_123">View Details</Button>
    </Actions>
    <Divider />
    <Section>
      <b>Luxury Tent</b>
      <br />
      <b>One person only</b>. Shared modern bathrooms and showers in lounge
      building. Temperature control with heated blankets. Lights and electrical
      outlets.
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/tent.png"
        alt="Redwood Suite"
      />
    </Section>
    <Context>
      1x Queen Bed
      <span>|</span>
      $260 / night
    </Context>
    <Actions>
      <Button value="click_me_123">Choose</Button>
      <Button value="click_me_123">View Details</Button>
    </Actions>
    <Divider />
    <Input type="submit" value="Submit" />
  </Modal>
);

const AppMenuModal = JSXSlack(
  <Modal title="App menu" close="Cancel">
    <Section>
      <b>
        Hi <a href="fakelink.toUser.com">@David</a>!
      </b>{" "}
      Here's how I can help you:
    </Section>
    <Divider />
    <Section>
      :calendar: <b>Create event</b>
      <br />
      Create a new event
      <Button value="click_me_123" style="primary">
        Create event
      </Button>
    </Section>
    <Section>
      :clipboard: <b>List of events</b>
      <br />
      Choose from different event lists
      <Select placeholder="Choose list">
        <Option value="value-0">My events</Option>
        <Option value="value-1">All events</Option>
        <Option value="value-2">Event invites</Option>
      </Select>
    </Section>
    <Section>
      :gear: <b>Settings</b>
      <br />
      Manage your notifications and team settings
      <Select placeholder="Edit settings">
        <Option value="value-0">Notifications</Option>
        <Option value="value-1">Team settings</Option>
      </Select>
    </Section>
    <Actions>
      <Button value="click_me_123">Send feedback</Button>
      <Button value="click_me_123">FAQs</Button>
    </Actions>
    <Input type="submit" value="Submit" />
  </Modal>
);

const NotificationSettingsModal = JSXSlack(
  <Modal title="Notification settings" close="Cancel">
    <Section>
      <p>
        <b>
          <a href="fakelink.toUrl.com">PR Strategy 2019</a> posts into{" "}
          <a href="fakelink.toChannel.com">#public-relations</a>
        </b>
      </p>
      <p>Select which notifications to send:</p>
    </Section>
    <Actions>
      <CheckboxGroup>
        <Checkbox value="tasks">
          New tasks
          <small>When new tasks are added to project</small>
        </Checkbox>
        <Checkbox value="comments">
          New comments
          <small>When new comments are added</small>
        </Checkbox>
        <Checkbox value="updates">
          Project updates
          <small>When project is updated</small>
        </Checkbox>
      </CheckboxGroup>
    </Actions>
    <Input type="submit" value="Submit" />
  </Modal>
);

const YourItineraryModal = JSXSlack(
  <Modal title="Your itinerary" close="Cancel">
    <Header>:tada: You're all set! This is your booking summary.</Header>
    <Divider />
    <Section>
      <Field>
        <b>Attendee</b>
        <br />
        Katie Chen
      </Field>
      <Field>
        <b>Date</b>
        <br />
        Oct 22-23
      </Field>
    </Section>

    <Context>:house: Accommodation</Context>
    <Divider />
    <Section>
      <b>Redwood Suite</b>
      <br />
      <b>Share with 2 other person</b>. Studio home. Modern bathroom. TV.
      Heating. Full kitchen. Patio with lounge chairs and campfire style fire
      pit and grill.
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/redwood-suite.png"
        alt="Redwood Suite"
      />
    </Section>

    <Context>:fork_and_knife: Food &amp; Dietary restrictions</Context>
    <Divider />
    <Section>
      <b>All-rounder</b>
      <br />
      You eat most meats, seafood, dairy and vegetables.
    </Section>

    <Context>:woman-running: Activities</Context>
    <Divider />
    <Section>
      <b>Winery tour and tasting</b>
      <Field>Wednesday, Oct 22 2019, 2pm-5pm</Field>
      <Field>Hosted by Sandra Mullens</Field>
    </Section>
    <Section>
      <b>Sunrise hike to Mount Amazing</b>
      <Field>Thursday, Oct 23 2019, 5:30am</Field>
      <Field>Hosted by Jordan Smith</Field>
    </Section>
    <Section>
      <b>Design systems brainstorm</b>
      <Field>Thursday, Oct 23 2019, 11a</Field>
      <Field>Hosted by Mary Lee</Field>
    </Section>

    <Input type="submit" value="Submit" />
  </Modal>
);

const TicketAppModal = JSXSlack(
  <Modal title="Ticket app" close="Cancel">
    <Section>
      Pick a ticket list from the dropdown
      <Select placeholder="Select an item">
        <Option value="all_tickets">All Tickets</Option>
        <Option value="assigned_to_me" selected>
          Assigned To Me
        </Option>
        <Option value="issued_by_me">Issued By Me</Option>
      </Select>
    </Section>

    <Divider />
    <Context>
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/highpriority.png"
        alt="High Priority"
      />
      <b>High Priority</b>
    </Context>
    <Divider />

    <Section>
      <b>
        <a href="fakelink.com">WEB-1098 Adjust borders on homepage graphic</a>
      </b>
      <Overflow>
        <OverflowItem value="done">
          :white_check_mark: Mark as done
        </OverflowItem>
        <OverflowItem value="edit">:pencil: Edit</OverflowItem>
        <OverflowItem value="delete">:x: Delete</OverflowItem>
      </Overflow>
    </Section>
    <Context>
      Awaiting Release
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/task-icon.png"
        alt="Task Icon"
      />{" "}
      Task
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/profile_1.png"
        alt="Michael Scott"
      />{" "}
      <a href="fakelink.toUser.com">Michael Scott</a>
    </Context>

    <Section>
      <b>
        <a href="fakelink.com">
          MOB-2011 Deep-link from web search results to product page
        </a>
      </b>
      <Overflow>
        <OverflowItem value="done">
          :white_check_mark: Mark as done
        </OverflowItem>
        <OverflowItem value="edit">:pencil: Edit</OverflowItem>
        <OverflowItem value="delete">:x: Delete</OverflowItem>
      </Overflow>
    </Section>
    <Context>
      Open
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/newfeature.png"
        alt="New Feature Icon"
      />{" "}
      New Feature
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/profile_2.png"
        alt="Pam Beasely"
      />{" "}
      <a href="fakelink.toUser.com">Pam Beasely</a>
    </Context>

    <Divider />
    <Context>
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/mediumpriority.png"
        alt="palm tree"
      />
      <b>Medium Priority</b>
    </Context>
    <Divider />

    <Section>
      <b>
        <a href="fakelink.com">WEB-1098 Adjust borders on homepage graphic</a>
      </b>
      <Overflow>
        <OverflowItem value="done">
          :white_check_mark: Mark as done
        </OverflowItem>
        <OverflowItem value="edit">:pencil: Edit</OverflowItem>
        <OverflowItem value="delete">:x: Delete</OverflowItem>
      </Overflow>
    </Section>
    <Context>
      Awaiting Release
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/task-icon.png"
        alt="Task Icon"
      />{" "}
      Task
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/profile_1.png"
        alt="Michael Scott"
      />{" "}
      <a href="fakelink.toUser.com">Michael Scott</a>
    </Context>

    <Section>
      <b>
        <a href="fakelink.com">
          MOB-2011 Deep-link from web search results to product page
        </a>
      </b>
      <Overflow>
        <OverflowItem value="done">
          :white_check_mark: Mark as done
        </OverflowItem>
        <OverflowItem value="edit">:pencil: Edit</OverflowItem>
        <OverflowItem value="delete">:x: Delete</OverflowItem>
      </Overflow>
    </Section>
    <Context>
      Open
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/newfeature.png"
        alt="New Feature Icon"
      />{" "}
      New Feature
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/profile_2.png"
        alt="Pam Beasely"
      />{" "}
      <a href="fakelink.toUser.com">Pam Beasely</a>
    </Context>

    <Section>
      <b>
        <a href="fakelink.com">WEB-1098 Adjust borders on homepage graphic</a>
      </b>
      <Overflow>
        <OverflowItem value="done">
          :white_check_mark: Mark as done
        </OverflowItem>
        <OverflowItem value="edit">:pencil: Edit</OverflowItem>
        <OverflowItem value="delete">:x: Delete</OverflowItem>
      </Overflow>
    </Section>
    <Context>
      Awaiting Release
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/task-icon.png"
        alt="Task Icon"
      />{" "}
      Task
      <Image
        src="https://api.slack.com/img/blocks/bkb_template_images/profile_1.png"
        alt="Michael Scott"
      />{" "}
      <a href="fakelink.toUser.com">Michael Scott</a>
    </Context>

    <Input type="submit" value="Submit" />
  </Modal>
);
