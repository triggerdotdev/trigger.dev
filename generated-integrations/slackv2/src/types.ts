export type SlackvTypes = (PostMessageInput | PostMessageOutput | ConversationsListInput | ConversationsListOutput)
export type UserID = string
export type TeamOrEnterpriseID = string
export type EnterpriseID = string
export type ChannelLikeConversationID = string
export type TeamID = string
export type TimestampInFormat0123456789012345 = string
/**
 * This is a very loose definition, in the future, we'll populate this with deeper schema in this definition namespace.
 */
export type BlockKitBlocks = {
  type: string
  [k: string]: unknown
}[]
export type BotUserID = string
export type NilBotIdSetWhenDisplayAsBotIsFalse = null
export type AppID = string
export type FileCommentID = string
export type ChannelID = string
export type PrivateChannelID = string
export type FileID = string
export type DirectMessageChannelID = string
export type NameOfAChannel = string
export type UserIDOrEmptyStringUsedForTopicAndPurposeCreation = string
export type NameOfTheEnterpriseOrg = string
export type FieldToDetermineWhetherAChannelHasEverBeenSharedDisconnectedInThePast = number
export type FieldToDetermineWhetherAChannelHasEverBeenSharedDisconnectedInThePast1 = number
export type DefaultSuccessResponse = true

export interface PostMessageInput {
  /**
   * Pass true to post the message as the authed user, instead of as a bot. Defaults to false. See [authorship](#authorship) below.
   */
  as_user?: string
  /**
   * A JSON-based array of structured attachments, presented as a URL-encoded string.
   */
  attachments?: string
  /**
   * A JSON-based array of structured blocks, presented as a URL-encoded string.
   */
  blocks?: string
  /**
   * Channel, private group, or IM channel to send message to. Can be an encoded ID, or a name. See [below](#channels) for more details.
   */
  channel: string
  /**
   * Emoji to use as the icon for this message. Overrides `icon_url`. Must be used in conjunction with `as_user` set to `false`, otherwise ignored. See [authorship](#authorship) below.
   */
  icon_emoji?: string
  /**
   * URL to an image to use as the icon for this message. Must be used in conjunction with `as_user` set to false, otherwise ignored. See [authorship](#authorship) below.
   */
  icon_url?: string
  /**
   * Find and link channel names and usernames.
   */
  link_names?: boolean
  /**
   * Disable Slack markup parsing by setting to `false`. Enabled by default.
   */
  mrkdwn?: boolean
  /**
   * Change how messages are treated. Defaults to `none`. See [below](#formatting).
   */
  parse?: string
  /**
   * Used in conjunction with `thread_ts` and indicates whether reply should be made visible to everyone in the channel or conversation. Defaults to `false`.
   */
  reply_broadcast?: boolean
  /**
   * How this field works and whether it is required depends on other fields you use in your API call. [See below](#text_usage) for more detail.
   */
  text?: string
  /**
   * Provide another message's `ts` value to make this message a reply. Avoid using a reply's `ts` value; use its parent instead.
   */
  thread_ts?: string
  /**
   * Pass true to enable unfurling of primarily text-based content.
   */
  unfurl_links?: boolean
  /**
   * Pass false to disable unfurling of media content.
   */
  unfurl_media?: boolean
  /**
   * Set your bot's user name. Must be used in conjunction with `as_user` set to false, otherwise ignored. See [authorship](#authorship) below.
   */
  username?: string
}
export interface PostMessageOutput {
  /**
   * Channel ID where the message was posted
   */
  channel: string
  message: {
    attachments?: {
      fallback: string
      id: number
      text: string
    }[]
    bot_id: string
    subtype?: string
    text: string
    ts: string
    type: string
    user?: string
  }
  ok: boolean
  ts: string
}
export interface ConversationsListInput {
  /**
   * Set to `true` to exclude archived channels from the list
   */
  exclude_archived?: boolean
  /**
   * Mix and match channel types by providing a comma-separated list of any combination of `public_channel`, `private_channel`, `mpim`, `im`
   */
  types?: string
  /**
   * The maximum number of items to return. Fewer than the requested number of items may be returned, even if the end of the list hasn't been reached. Must be an integer no larger than 1000.
   */
  limit?: number
  /**
   * Paginate through collections of data by setting the `cursor` parameter to a `next_cursor` attribute returned by a previous request's `response_metadata`. Default value fetches the first "page" of the collection. See [pagination](/docs/pagination) for more detail.
   */
  cursor?: string
}
/**
 * Schema for successful response from conversations.list method
 */
export interface ConversationsListOutput {
  channels: [] | [ConversationObject] | [ConversationObject, ConversationMPIMObject] | [ConversationObject, ConversationMPIMObject, ConversationIMChannelObjectFromConversationsMethods][]
  ok: DefaultSuccessResponse
  response_metadata?: {
    next_cursor: string
  }
}
export interface ConversationObject {
  accepted_user?: UserID
  /**
   * @minItems 0
   */
  connected_team_ids?: TeamOrEnterpriseID[]
  conversation_host_id?: TeamOrEnterpriseID
  created: number
  creator: UserID
  display_counts?: {
    display_counts: number
    guest_counts: number
  }
  enterprise_id?: EnterpriseID
  has_pins?: boolean
  id: ChannelLikeConversationID
  /**
   * @minItems 0
   */
  internal_team_ids?: TeamID[]
  is_archived: boolean
  is_channel: boolean
  is_ext_shared?: boolean
  is_frozen?: boolean
  is_general: boolean
  is_global_shared?: boolean
  is_group: boolean
  is_im: boolean
  is_member?: boolean
  is_moved?: number
  is_mpim: false
  is_non_threadable?: boolean
  is_open?: boolean
  is_org_default?: boolean
  is_org_mandatory?: boolean
  is_org_shared: boolean
  is_pending_ext_shared?: boolean
  is_private: boolean
  is_read_only?: boolean
  is_shared: boolean
  is_starred?: boolean
  is_thread_only?: boolean
  last_read?: TimestampInFormat0123456789012345
  latest?: [] | [MessageObject] | [MessageObject, null]
  /**
   * @minItems 0
   */
  members?: UserID[]
  name: string
  name_normalized: string
  num_members?: number
  parent_conversation?: [] | [ChannelLikeConversationID] | [ChannelLikeConversationID, null]
  /**
   * @minItems 0
   */
  pending_connected_team_ids?: TeamID[]
  /**
   * @minItems 0
   */
  pending_shared?: TeamID[]
  pin_count?: number
  /**
   * @minItems 0
   */
  previous_names?: NameOfAChannel[]
  priority?: number
  purpose: {
    creator: UserIDOrEmptyStringUsedForTopicAndPurposeCreation
    last_set: number
    value: string
  }
  /**
   * @minItems 0
   */
  shared_team_ids?: TeamID[]
  /**
   * @minItems 0
   */
  shares?: {
    accepted_user?: UserID
    is_active: boolean
    team: TeamObject
    user: UserID
  }[]
  timezone_count?: number
  topic: {
    creator: UserIDOrEmptyStringUsedForTopicAndPurposeCreation
    last_set: number
    value: string
  }
  unlinked?: FieldToDetermineWhetherAChannelHasEverBeenSharedDisconnectedInThePast
  unread_count?: number
  unread_count_display?: number
  use_case?: string
  user?: UserID
  version?: number
}
export interface MessageObject {
  /**
   * @minItems 1
   */
  attachments?: [{
    fallback?: string
    id: number
    image_bytes?: number
    image_height?: number
    image_url?: string
    image_width?: number
  }, ...({
    fallback?: string
    id: number
    image_bytes?: number
    image_height?: number
    image_url?: string
    image_width?: number
  })[]]
  blocks?: BlockKitBlocks
  bot_id?: [] | [BotUserID] | [BotUserID, NilBotIdSetWhenDisplayAsBotIsFalse]
  bot_profile?: BotProfileObject
  client_msg_id?: string
  comment?: FileCommentObject
  display_as_bot?: boolean
  file?: FileObject
  /**
   * @minItems 1
   */
  files?: [FileObject, ...(FileObject)[]]
  icons?: {
    emoji?: string
    image_64?: string
  }
  inviter?: UserID
  is_delayed_message?: boolean
  is_intro?: boolean
  is_starred?: boolean
  last_read?: TimestampInFormat0123456789012345
  latest_reply?: TimestampInFormat0123456789012345
  name?: string
  old_name?: string
  parent_user_id?: UserID
  permalink?: string
  pinned_to?: ChannelLikeConversationID[]
  purpose?: string
  reactions?: ReactionObject[]
  reply_count?: number
  /**
   * @minItems 1
   */
  reply_users?: [UserID, ...(UserID)[]]
  reply_users_count?: number
  source_team?: TeamOrEnterpriseID
  subscribed?: boolean
  subtype?: string
  team?: TeamOrEnterpriseID
  text: string
  thread_ts?: TimestampInFormat0123456789012345
  topic?: string
  ts: TimestampInFormat0123456789012345
  type: string
  unread_count?: number
  upload?: boolean
  user?: UserID
  user_profile?: {
    avatar_hash: string
    display_name: string
    display_name_normalized?: string
    first_name: (string | null)
    image_72: string
    is_restricted: boolean
    is_ultra_restricted: boolean
    name: string
    real_name: string
    real_name_normalized?: string
    team: TeamOrEnterpriseID
  }
  user_team?: TeamOrEnterpriseID
  username?: string
}
export interface BotProfileObject {
  app_id: AppID
  deleted: boolean
  icons: {
    image_36: string
    image_48: string
    image_72: string
  }
  id: BotUserID
  name: string
  team_id: TeamID
  updated: number
}
export interface FileCommentObject {
  comment: string
  created: number
  id: FileCommentID
  is_intro: boolean
  is_starred?: boolean
  num_stars?: number
  pinned_info?: InfoForAPinnedItem
  pinned_to?: ChannelLikeConversationID[]
  reactions?: ReactionObject[]
  timestamp: number
  user: UserID
}
export interface InfoForAPinnedItem {

}
export interface ReactionObject {
  count: number
  name: string
  users: UserID[]
  [k: string]: unknown
}
export interface FileObject {
  channels?: ChannelID[]
  comments_count?: number
  created?: number
  date_delete?: number
  display_as_bot?: boolean
  editable?: boolean
  editor?: UserID
  external_id?: string
  external_type?: string
  external_url?: string
  filetype?: string
  groups?: PrivateChannelID[]
  has_rich_preview?: boolean
  id?: FileID
  image_exif_rotation?: number
  ims?: DirectMessageChannelID[]
  is_external?: boolean
  is_public?: boolean
  is_starred?: boolean
  is_tombstoned?: boolean
  last_editor?: UserID
  mimetype?: string
  mode?: string
  name?: string
  non_owner_editable?: boolean
  num_stars?: number
  original_h?: number
  original_w?: number
  permalink?: string
  permalink_public?: string
  pinned_info?: InfoForAPinnedItem
  pinned_to?: ChannelLikeConversationID[]
  pretty_type?: string
  preview?: string
  public_url_shared?: boolean
  reactions?: ReactionObject[]
  shares?: {
    private?: {

    }
    public?: {

    }
  }
  size?: number
  source_team?: TeamID
  state?: string
  thumb_1024?: string
  thumb_1024_h?: number
  thumb_1024_w?: number
  thumb_160?: string
  thumb_360?: string
  thumb_360_h?: number
  thumb_360_w?: number
  thumb_480?: string
  thumb_480_h?: number
  thumb_480_w?: number
  thumb_64?: string
  thumb_720?: string
  thumb_720_h?: number
  thumb_720_w?: number
  thumb_80?: string
  thumb_800?: string
  thumb_800_h?: number
  thumb_800_w?: number
  thumb_960?: string
  thumb_960_h?: number
  thumb_960_w?: number
  thumb_tiny?: string
  timestamp?: number
  title?: string
  updated?: number
  url_private?: string
  url_private_download?: string
  user?: string
  user_team?: TeamID
  username?: string
}
export interface TeamObject {
  archived?: boolean
  avatar_base_url?: string
  created?: number
  date_create?: number
  deleted?: boolean
  description?: (null | string)
  discoverable?: [] | [null] | [null, string]
  domain: string
  email_domain: string
  enterprise_id?: EnterpriseID
  enterprise_name?: NameOfTheEnterpriseOrg
  external_org_migrations?: ExternalOrgMigrations
  has_compliance_export?: boolean
  icon: {
    image_102?: string
    image_132?: string
    image_230?: string
    image_34?: string
    image_44?: string
    image_68?: string
    image_88?: string
    image_default?: boolean
  }
  id: TeamOrEnterpriseID
  is_assigned?: boolean
  is_enterprise?: number
  is_over_storage_limit?: boolean
  limit_ts?: number
  locale?: string
  messages_count?: number
  msg_edit_window_mins?: number
  name: string
  over_integrations_limit?: boolean
  over_storage_limit?: boolean
  pay_prod_cur?: string
  plan?: ("" | "std" | "plus" | "compliance" | "enterprise")
  primary_owner?: {
    email: string
    id: string
  }
  sso_provider?: {
    label?: string
    name?: string
    type?: string
  }
}
export interface ExternalOrgMigrations {
  current: {
    date_started: number
    team_id: string
  }[]
  date_updated: number
}
export interface ConversationMPIMObject {
  accepted_user?: UserID
  /**
   * @minItems 0
   */
  connected_team_ids?: TeamID[]
  conversation_host_id?: TeamOrEnterpriseID
  created: number
  creator: UserID
  display_counts?: {
    display_counts: number
    guest_counts: number
  }
  id: ChannelLikeConversationID
  /**
   * @minItems 0
   */
  internal_team_ids?: TeamID[]
  is_archived: boolean
  is_channel: boolean
  is_ext_shared?: boolean
  is_frozen?: boolean
  is_general: boolean
  is_group: boolean
  is_im: boolean
  is_member?: boolean
  is_moved?: number
  is_mpim: true
  is_non_threadable?: boolean
  is_open?: boolean
  is_org_shared: boolean
  is_pending_ext_shared?: boolean
  is_private: boolean
  is_read_only?: boolean
  is_shared: boolean
  is_starred?: boolean
  is_thread_only?: boolean
  last_read?: TimestampInFormat0123456789012345
  latest?: [] | [MessageObject] | [MessageObject, null]
  /**
   * @minItems 0
   */
  members?: UserID[]
  name: string
  name_normalized: string
  num_members?: number
  parent_conversation?: [] | [ChannelLikeConversationID] | [ChannelLikeConversationID, null]
  /**
   * @minItems 0
   */
  pending_connected_team_ids?: TeamID[]
  /**
   * @minItems 0
   */
  pending_shared?: TeamID[]
  pin_count?: number
  /**
   * @minItems 0
   */
  previous_names?: NameOfAChannel[]
  priority?: number
  purpose: {
    creator: UserIDOrEmptyStringUsedForTopicAndPurposeCreation
    last_set: number
    value: string
  }
  /**
   * @minItems 0
   */
  shared_team_ids?: TeamID[]
  /**
   * @minItems 0
   */
  shares?: {
    accepted_user?: UserID
    is_active: boolean
    team: TeamObject
    user: UserID
  }[]
  timezone_count?: number
  topic: {
    creator: UserIDOrEmptyStringUsedForTopicAndPurposeCreation
    last_set: number
    value: string
  }
  unlinked?: FieldToDetermineWhetherAChannelHasEverBeenSharedDisconnectedInThePast1
  unread_count?: number
  unread_count_display?: number
  user?: UserID
  version?: number
}
export interface ConversationIMChannelObjectFromConversationsMethods {
  created: number
  has_pins?: boolean
  id: DirectMessageChannelID
  is_archived?: boolean
  is_ext_shared?: boolean
  is_frozen?: boolean
  is_im: boolean
  is_open?: boolean
  is_org_shared: boolean
  is_shared?: boolean
  is_starred?: boolean
  is_user_deleted?: boolean
  last_read?: TimestampInFormat0123456789012345
  latest?: [] | [MessageObject] | [MessageObject, null]
  parent_conversation?: [] | [ChannelLikeConversationID] | [ChannelLikeConversationID, null]
  pin_count?: number
  priority: number
  /**
   * @minItems 0
   */
  shares?: {
    date_create: number
    id: TeamID
    is_active: boolean
    name: string
    team: TeamObject
  }[]
  unread_count?: number
  unread_count_display?: number
  user: UserID
  version?: number
}
