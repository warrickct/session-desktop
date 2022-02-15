import Backbone from 'backbone';
import _ from 'lodash';
import { getMessageQueue } from '../session';
import { getConversationController } from '../session/conversations';
import { ClosedGroupVisibleMessage } from '../session/messages/outgoing/visibleMessage/ClosedGroupVisibleMessage';
import { PubKey } from '../session/types';
import { UserUtils } from '../session/utils';
import { BlockedNumberController } from '../util';
import { leaveClosedGroup } from '../session/group/closed-group';
import { SignalService } from '../protobuf';
import { MessageModel } from './message';
import { MessageAttributesOptionals, MessageDirection, MessageModelType } from './messageType';
import autoBind from 'auto-bind';
import {
  getLastMessagesByConversation,
  getUnreadByConversation,
  getUnreadCountByConversation,
  removeMessage as dataRemoveMessage,
  saveMessages,
  updateConversation,
} from '../../ts/data/data';
import { toHex } from '../session/utils/String';
import {
  actions as conversationActions,
  conversationChanged,
  conversationsChanged,
  LastMessageStatusType,
  MessageModelPropsWithoutConvoProps,
  ReduxConversationType,
} from '../state/ducks/conversations';
import { ExpirationTimerUpdateMessage } from '../session/messages/outgoing/controlMessage/ExpirationTimerUpdateMessage';
import { TypingMessage } from '../session/messages/outgoing/controlMessage/TypingMessage';
import {
  VisibleMessage,
  VisibleMessageParams,
} from '../session/messages/outgoing/visibleMessage/VisibleMessage';
import { GroupInvitationMessage } from '../session/messages/outgoing/visibleMessage/GroupInvitationMessage';
import { ReadReceiptMessage } from '../session/messages/outgoing/controlMessage/receipt/ReadReceiptMessage';
import { OpenGroupUtils } from '../session/apis/open_group_api/utils';
import { OpenGroupVisibleMessage } from '../session/messages/outgoing/visibleMessage/OpenGroupVisibleMessage';
import { OpenGroupRequestCommonType } from '../session/apis/open_group_api/opengroupV2/ApiUtil';
import { getOpenGroupV2FromConversationId } from '../session/apis/open_group_api/utils/OpenGroupUtils';
import { createTaskWithTimeout } from '../session/utils/TaskWithTimeout';
import { perfEnd, perfStart } from '../session/utils/Performance';

import { ed25519Str } from '../session/onions/onionPath';
import { getDecryptedMediaUrl } from '../session/crypto/DecryptedAttachmentsManager';
import { IMAGE_JPEG } from '../types/MIME';
import { forceSyncConfigurationNowIfNeeded } from '../session/utils/syncUtils';
import { getNowWithNetworkOffset } from '../session/apis/snode_api/SNodeAPI';
import { createLastMessageUpdate } from '../types/Conversation';
import {
  ReplyingToMessageProps,
  SendMessageType,
} from '../components/conversation/composition/CompositionBox';
import { SettingsKey } from '../data/settings-key';
import {
  deleteExternalFilesOfConversation,
  getAbsoluteAttachmentPath,
  loadAttachmentData,
} from '../types/MessageAttachment';
import { getOurPubKeyStrFromCache } from '../session/utils/User';
import { MessageRequestResponse } from '../session/messages/outgoing/controlMessage/MessageRequestResponse';

export enum ConversationTypeEnum {
  GROUP = 'group',
  PRIVATE = 'private',
}

/**
 * all: all  notifications enabled, the default
 * disabled: no notifications at all
 * mentions_only: trigger a notification only on mentions of ourself
 */
export const ConversationNotificationSetting = ['all', 'disabled', 'mentions_only'] as const;
export type ConversationNotificationSettingType = typeof ConversationNotificationSetting[number];

export interface ConversationAttributes {
  profileName?: string;
  id: string;
  name?: string;
  // members are all members for this group. zombies excluded
  members: Array<string>;
  zombies: Array<string>; // only used for closed groups. Zombies are users which left but not yet removed by the admin
  left: boolean;
  expireTimer: number;
  mentionedUs: boolean;
  unreadCount: number;
  lastMessageStatus: LastMessageStatusType;
  lastMessage: string | null;

  active_at: number;
  lastJoinedTimestamp: number; // ClosedGroup: last time we were added to this group
  groupAdmins?: Array<string>;
  isKickedFromGroup?: boolean;
  avatarPath?: string;
  isMe?: boolean;
  subscriberCount?: number;
  is_medium_group?: boolean;
  type: string;
  avatarPointer?: string;
  avatar?: any;
  /* Avatar hash is currently used for opengroupv2. it's sha256 hash of the base64 avatar data. */
  avatarHash?: string;
  server?: any;
  nickname?: string;
  profile?: any;
  profileAvatar?: any;
  /**
   * Consider this being a hex string if it set
   */
  profileKey?: string;
  triggerNotificationsFor: ConversationNotificationSettingType;
  isTrustedForAttachmentDownload: boolean;
  isPinned: boolean;
  isApproved: boolean;
  didApproveMe: boolean;
}

export interface ConversationAttributesOptionals {
  profileName?: string;
  id: string;
  name?: string;
  members?: Array<string>;
  zombies?: Array<string>;
  left?: boolean;
  expireTimer?: number;
  mentionedUs?: boolean;
  unreadCount?: number;
  lastMessageStatus?: LastMessageStatusType;
  lastMessage: string | null;
  active_at?: number;
  timestamp?: number; // timestamp of what?
  lastJoinedTimestamp?: number;
  groupAdmins?: Array<string>;
  isKickedFromGroup?: boolean;
  avatarPath?: string;
  isMe?: boolean;
  subscriberCount?: number;
  is_medium_group?: boolean;
  type: string;
  avatarPointer?: string;
  avatar?: any;
  avatarHash?: string;
  server?: any;
  nickname?: string;
  profile?: any;
  profileAvatar?: any;
  /**
   * Consider this being a hex string if it set
   */
  profileKey?: string;
  triggerNotificationsFor?: ConversationNotificationSettingType;
  isTrustedForAttachmentDownload?: boolean;
  isPinned: boolean;
  isApproved?: boolean;
  didApproveMe?: boolean;
}

/**
 * This function mutates optAttributes
 * @param optAttributes the entry object attributes to set the defaults to.
 */
export const fillConvoAttributesWithDefaults = (
  optAttributes: ConversationAttributesOptionals
): ConversationAttributes => {
  return _.defaults(optAttributes, {
    members: [],
    zombies: [],
    left: false,
    unreadCount: 0,
    lastMessageStatus: null,
    lastJoinedTimestamp: new Date('1970-01-01Z00:00:00:000').getTime(),
    groupAdmins: [],
    isKickedFromGroup: false,
    isMe: false,
    subscriberCount: 0,
    is_medium_group: false,
    lastMessage: null,
    expireTimer: 0,
    mentionedUs: false,
    active_at: 0,
    triggerNotificationsFor: 'all', // if the settings is not set in the db, this is the default
    isTrustedForAttachmentDownload: false, // we don't trust a contact until we say so
    isPinned: false,
    isApproved: false,
    didApproveMe: false,
  });
};

export class ConversationModel extends Backbone.Model<ConversationAttributes> {
  public updateLastMessage: () => any;
  public throttledBumpTyping: () => void;
  public throttledNotify: (message: MessageModel) => void;
  public markRead: (newestUnreadDate: number, providedOptions?: any) => Promise<void>;
  public initialPromise: any;

  private typingRefreshTimer?: NodeJS.Timeout | null;
  private typingPauseTimer?: NodeJS.Timeout | null;
  private typingTimer?: NodeJS.Timeout | null;
  private lastReadTimestamp: number;

  private pending?: Promise<any>;

  constructor(attributes: ConversationAttributesOptionals) {
    super(fillConvoAttributesWithDefaults(attributes));

    // This may be overridden by getConversationController().getOrCreate, and signify
    //   our first save to the database. Or first fetch from the database.
    this.initialPromise = Promise.resolve();
    autoBind(this);

    this.throttledBumpTyping = _.throttle(this.bumpTyping, 300);
    this.updateLastMessage = _.throttle(this.bouncyUpdateLastMessage.bind(this), 1000, {
      trailing: true,
      leading: true,
    });

    this.throttledNotify = _.debounce(this.notify, 500, { maxWait: 5000, trailing: true });
    //start right away the function is called, and wait 1sec before calling it again
    const markReadDebounced = _.debounce(this.markReadBouncy, 1000, {
      leading: true,
      trailing: true,
    });
    // tslint:disable-next-line: no-async-without-await
    this.markRead = async (newestUnreadDate: number) => {
      const lastReadTimestamp = this.lastReadTimestamp;
      if (newestUnreadDate > lastReadTimestamp) {
        this.lastReadTimestamp = newestUnreadDate;
      }
      void markReadDebounced(newestUnreadDate);
    };
    // Listening for out-of-band data updates

    this.typingRefreshTimer = null;
    this.typingPauseTimer = null;
    this.lastReadTimestamp = 0;
    window.inboxStore?.dispatch(
      conversationChanged({ id: this.id, data: this.getConversationModelProps() })
    );
  }

  public idForLogging() {
    if (this.isPrivate()) {
      return this.id;
    }

    if (this.isPublic()) {
      return `opengroup(${this.id})`;
    }

    return `group(${ed25519Str(this.id)})`;
  }

  public isMe() {
    return UserUtils.isUsFromCache(this.id);
  }
  public isPublic(): boolean {
    return Boolean(this.id && this.id.match(OpenGroupUtils.openGroupPrefixRegex));
  }
  public isOpenGroupV2(): boolean {
    return OpenGroupUtils.isOpenGroupV2(this.id);
  }
  public isClosedGroup() {
    return this.get('type') === ConversationTypeEnum.GROUP && !this.isPublic();
  }

  public isBlocked() {
    if (!this.id || this.isMe()) {
      return false;
    }

    if (this.isClosedGroup()) {
      return BlockedNumberController.isGroupBlocked(this.id);
    }

    if (this.isPrivate()) {
      return BlockedNumberController.isBlocked(this.id);
    }

    return false;
  }

  public isMediumGroup() {
    return this.get('is_medium_group');
  }

  /**
   * Returns true if this conversation is active
   * i.e. the conversation is visibie on the left pane. (Either we or another user created this convo).
   * This is useful because we do not want bumpTyping on the first message typing to a new convo to
   *  send a message.
   */
  public isActive() {
    return Boolean(this.get('active_at'));
  }

  public async cleanup() {
    await deleteExternalFilesOfConversation(this.attributes);
    window.profileImages.removeImage(this.id);
  }

  public async updateProfileAvatar() {
    if (this.isPublic()) {
      return;
    }

    // Remove old identicons
    if (window.profileImages.hasImage(this.id)) {
      window.profileImages.removeImage(this.id);
      await this.setProfileAvatar(null);
    }
  }

  public async onExpired(_message: MessageModel) {
    await this.updateLastMessage();

    // removeMessage();
  }

  public getGroupAdmins(): Array<string> {
    const groupAdmins = this.get('groupAdmins');

    return groupAdmins && groupAdmins?.length > 0 ? groupAdmins : [];
  }

  // tslint:disable-next-line: cyclomatic-complexity
  public getConversationModelProps(): ReduxConversationType {
    const groupAdmins = this.getGroupAdmins();
    const isPublic = this.isPublic();

    const members = this.isGroup() && !isPublic ? this.get('members') : [];
    const zombies = this.isGroup() && !isPublic ? this.get('zombies') : [];
    const ourNumber = UserUtils.getOurPubKeyStrFromCache();
    const avatarPath = this.getAvatarPath();
    const isPrivate = this.isPrivate();
    const isGroup = !isPrivate;
    const weAreAdmin = this.isAdmin(ourNumber);
    const isMe = this.isMe();
    const isTyping = !!this.typingTimer;
    const name = this.getName();
    const profileName = this.getProfileName();
    const unreadCount = this.get('unreadCount') || undefined;
    const mentionedUs = this.get('mentionedUs') || undefined;
    const isBlocked = this.isBlocked();
    const subscriberCount = this.get('subscriberCount');
    const isPinned = this.isPinned();
    const isApproved = this.isApproved();
    const didApproveMe = this.didApproveMe();
    const hasNickname = !!this.getNickname();
    const isKickedFromGroup = !!this.get('isKickedFromGroup');
    const left = !!this.get('left');
    const expireTimer = this.get('expireTimer');
    const currentNotificationSetting = this.get('triggerNotificationsFor');

    // To reduce the redux store size, only set fields which cannot be undefined.
    // For instance, a boolean can usually be not set if false, etc
    const toRet: ReduxConversationType = {
      id: this.id as string,
      activeAt: this.get('active_at'),
      type: isPrivate ? ConversationTypeEnum.PRIVATE : ConversationTypeEnum.GROUP,
    };

    if (isPrivate) {
      toRet.isPrivate = true;
    }

    if (isGroup) {
      toRet.isGroup = true;
    }

    if (weAreAdmin) {
      toRet.weAreAdmin = true;
    }

    if (isMe) {
      toRet.isMe = true;
    }
    if (isPublic) {
      toRet.isPublic = true;
    }
    if (isTyping) {
      toRet.isTyping = true;
    }

    if (isTyping) {
      toRet.isTyping = true;
    }

    if (avatarPath) {
      toRet.avatarPath = avatarPath;
    }

    if (name) {
      toRet.name = name;
    }

    if (profileName) {
      toRet.profileName = profileName;
    }

    if (unreadCount) {
      toRet.unreadCount = unreadCount;
    }

    if (mentionedUs) {
      toRet.mentionedUs = mentionedUs;
    }

    if (isBlocked) {
      toRet.isBlocked = isBlocked;
    }
    if (hasNickname) {
      toRet.hasNickname = hasNickname;
    }
    if (isKickedFromGroup) {
      toRet.isKickedFromGroup = isKickedFromGroup;
    }
    if (left) {
      toRet.left = left;
    }
    if (isPinned) {
      toRet.isPinned = isPinned;
    }
    if (didApproveMe) {
      toRet.didApproveMe = didApproveMe;
    }
    if (isApproved) {
      toRet.isApproved = isApproved;
    }
    if (subscriberCount) {
      toRet.subscriberCount = subscriberCount;
    }
    if (groupAdmins && groupAdmins.length) {
      toRet.groupAdmins = _.uniq(groupAdmins);
    }
    if (members && members.length) {
      toRet.members = _.uniq(members);
    }

    if (zombies && zombies.length) {
      toRet.zombies = _.uniq(zombies);
    }

    if (expireTimer) {
      toRet.expireTimer = expireTimer;
    }

    if (
      currentNotificationSetting &&
      currentNotificationSetting !== ConversationNotificationSetting[0]
    ) {
      toRet.currentNotificationSetting = currentNotificationSetting;
    }

    const lastMessageText = this.get('lastMessage');
    if (lastMessageText && lastMessageText.length) {
      const lastMessageStatus = this.get('lastMessageStatus');

      toRet.lastMessage = {
        status: lastMessageStatus,
        text: lastMessageText,
      };
    }
    return toRet;
  }

  public async updateGroupAdmins(groupAdmins: Array<string>) {
    const existingAdmins = _.uniq(_.sortBy(this.getGroupAdmins()));
    const newAdmins = _.uniq(_.sortBy(groupAdmins));

    if (_.isEqual(existingAdmins, newAdmins)) {
      return;
    }
    this.set({ groupAdmins });
    await this.commit();
  }

  public async onReadMessage(message: MessageModel, readAt: number) {
    // We mark as read everything older than this message - to clean up old stuff
    //   still marked unread in the database. If the user generally doesn't read in
    //   the desktop app, so the desktop app only gets read syncs, we can very
    //   easily end up with messages never marked as read (our previous early read
    //   sync handling, read syncs never sent because app was offline)

    // We queue it because we often get a whole lot of read syncs at once, and
    //   their markRead calls could very easily overlap given the async pull from DB.

    // Lastly, we don't send read syncs for any message marked read due to a read
    //   sync. That's a notification explosion we don't need.
    return this.queueJob(() =>
      this.markReadBouncy(message.get('received_at') as any, {
        sendReadReceipts: false,
        readAt,
      })
    );
  }

  public async getUnread() {
    return getUnreadByConversation(this.id);
  }

  public async getUnreadCount() {
    const unreadCount = await getUnreadCountByConversation(this.id);

    return unreadCount;
  }

  public async queueJob(callback: () => Promise<void>) {
    // tslint:disable-next-line: no-promise-as-boolean
    const previous = this.pending || Promise.resolve();

    const taskWithTimeout = createTaskWithTimeout(callback, `conversation ${this.idForLogging()}`);

    this.pending = previous.then(taskWithTimeout, taskWithTimeout);
    const current = this.pending;

    void current.then(() => {
      if (this.pending === current) {
        delete this.pending;
      }
    });

    return current;
  }
  public getRecipients() {
    if (this.isPrivate()) {
      return [this.id];
    }
    const me = UserUtils.getOurPubKeyStrFromCache();
    return _.without(this.get('members'), me);
  }

  public async getQuoteAttachment(attachments: any, preview: any) {
    if (attachments && attachments.length) {
      return Promise.all(
        attachments
          .filter(
            (attachment: any) =>
              attachment && attachment.contentType && !attachment.pending && !attachment.error
          )
          .slice(0, 1)
          .map(async (attachment: any) => {
            const { fileName, thumbnail, contentType } = attachment;

            return {
              contentType,
              // Our protos library complains about this field being undefined, so we
              //   force it to null
              fileName: fileName || null,
              thumbnail: thumbnail
                ? {
                    ...(await loadAttachmentData(thumbnail)),
                    objectUrl: getAbsoluteAttachmentPath(thumbnail.path),
                  }
                : null,
            };
          })
      );
    }

    if (preview && preview.length) {
      return Promise.all(
        preview
          .filter((item: any) => item && item.image)
          .slice(0, 1)
          .map(async (attachment: any) => {
            const { image } = attachment;
            const { contentType } = image;

            return {
              contentType,
              // Our protos library complains about this field being undefined, so we
              //   force it to null
              fileName: null,
              thumbnail: image
                ? {
                    ...(await loadAttachmentData(image)),
                    objectUrl: getAbsoluteAttachmentPath(image.path),
                  }
                : null,
            };
          })
      );
    }

    return [];
  }

  public async makeQuote(quotedMessage: MessageModel): Promise<ReplyingToMessageProps | null> {
    const attachments = quotedMessage.get('attachments');
    const preview = quotedMessage.get('preview');

    const body = quotedMessage.get('body');
    const quotedAttachments = await this.getQuoteAttachment(attachments, preview);

    if (!quotedMessage.get('sent_at')) {
      window.log.warn('tried to make a quote without a sent_at timestamp');
      return null;
    }
    return {
      author: quotedMessage.getSource(),
      id: `${quotedMessage.get('sent_at')}` || '',
      // no need to quote the full message length.
      text: body?.slice(0, 100),
      attachments: quotedAttachments,
      timestamp: quotedMessage.get('sent_at') || 0,
      convoId: this.id,
    };
  }

  public toOpenGroupV2(): OpenGroupRequestCommonType {
    if (!this.isOpenGroupV2()) {
      throw new Error('tried to run toOpenGroup for not public group v2');
    }
    return getOpenGroupV2FromConversationId(this.id);
  }

  public async sendMessageJob(message: MessageModel, expireTimer: number | undefined) {
    try {
      const uploads = await message.uploadData();
      const { id } = message;
      const destination = this.id;

      const sentAt = message.get('sent_at');

      if (!sentAt) {
        throw new Error('sendMessageJob() sent_at must be set.');
      }

      if (this.isPublic() && !this.isOpenGroupV2()) {
        throw new Error('Only opengroupv2 are supported now');
      }
      // an OpenGroupV2 message is just a visible message
      const chatMessageParams: VisibleMessageParams = {
        body: uploads.body,
        identifier: id,
        timestamp: sentAt,
        attachments: uploads.attachments,
        expireTimer,
        preview: uploads.preview,
        quote: uploads.quote,
        lokiProfile: UserUtils.getOurProfile(),
      };

      const shouldApprove = !this.isApproved() && this.isPrivate();
      const hasMsgsFromOther =
        (await getMessagesByConversation(this.id, { type: MessageDirection.incoming })).length > 0;
      if (shouldApprove) {
        await this.setIsApproved(true);
        if (!this.didApproveMe() && hasMsgsFromOther) {
          await this.setDidApproveMe(true);
          await this.sendMessageRequestResponse(true);
          void forceSyncConfigurationNowIfNeeded();
        }
        // void forceSyncConfigurationNowIfNeeded();
      }

      // TODO: remove once dev-tested
      if (chatMessageParams.body?.includes('unapprove')) {
        await this.setIsApproved(false);
        await this.setDidApproveMe(false);
        // void forceSyncConfigurationNowIfNeeded();
      }

      if (this.isOpenGroupV2()) {
        const chatMessageOpenGroupV2 = new OpenGroupVisibleMessage(chatMessageParams);
        const roomInfos = this.toOpenGroupV2();
        if (!roomInfos) {
          throw new Error('Could not find this room in db');
        }

        // we need the return await so that errors are caught in the catch {}
        await getMessageQueue().sendToOpenGroupV2(chatMessageOpenGroupV2, roomInfos);
        return;
      }

      const destinationPubkey = new PubKey(destination);
      if (this.isPrivate()) {
        if (this.isMe()) {
          chatMessageParams.syncTarget = this.id;
          const chatMessageMe = new VisibleMessage(chatMessageParams);

          await getMessageQueue().sendSyncMessage(chatMessageMe);
          return;
        }
        // Handle Group Invitation Message
        if (message.get('groupInvitation')) {
          const groupInvitation = message.get('groupInvitation');
          const groupInvitMessage = new GroupInvitationMessage({
            identifier: id,
            timestamp: sentAt,
            name: groupInvitation.name,
            url: groupInvitation.url,
            expireTimer: this.get('expireTimer'),
          });
          // we need the return await so that errors are caught in the catch {}
          await getMessageQueue().sendToPubKey(destinationPubkey, groupInvitMessage);
          return;
        }
        const chatMessagePrivate = new VisibleMessage(chatMessageParams);

        await getMessageQueue().sendToPubKey(destinationPubkey, chatMessagePrivate);
        return;
      }

      if (this.isMediumGroup()) {
        const chatMessageMediumGroup = new VisibleMessage(chatMessageParams);
        const closedGroupVisibleMessage = new ClosedGroupVisibleMessage({
          chatMessage: chatMessageMediumGroup,
          groupId: destination,
        });

        // we need the return await so that errors are caught in the catch {}
        await getMessageQueue().sendToGroup(closedGroupVisibleMessage);
        return;
      }

      if (this.isClosedGroup()) {
        throw new Error('Legacy group are not supported anymore. You need to recreate this group.');
      }

      throw new TypeError(`Invalid conversation type: '${this.get('type')}'`);
    } catch (e) {
      await message.saveErrors(e);
      return null;
    }
  }

  public async sendMessageRequestResponse(isApproved: boolean) {
    const publicKey = getOurPubKeyStrFromCache();
    const timestamp = Date.now();

    const messageRequestResponseParams = {
      timestamp,
      publicKey,
      isApproved,
    };

    const messageRequestResponse = new MessageRequestResponse(messageRequestResponseParams);

    if (this.isPrivate()) {
      const pubkeyForSending = new PubKey(this.id);
      await getMessageQueue()
        .sendToPubKey(pubkeyForSending, messageRequestResponse)
        .catch(window?.log?.error);
    }
  }

  public async sendMessage(msg: SendMessageType) {
    const { attachments, body, groupInvitation, preview, quote } = msg;
    this.clearTypingTimers();

    const destination = this.id;
    const isPrivate = this.isPrivate();
    const expireTimer = this.get('expireTimer');
    const networkTimestamp = getNowWithNetworkOffset();

    window?.log?.info(
      'Sending message to conversation',
      this.idForLogging(),
      'with networkTimestamp: ',
      networkTimestamp
    );

    const messageModel = await this.addSingleOutgoingMessage({
      body,
      quote: _.isEmpty(quote) ? undefined : quote,
      preview,
      attachments,
      sent_at: networkTimestamp,
      received_at: now,
      expireTimer,
      serverTimestamp: this.isPublic() ? Date.now() : undefined,
      groupInvitation,
    });

    // We're offline!
    if (!window.textsecure.messaging) {
      const error = new Error('Network is not available');
      error.name = 'SendMessageNetworkError';
      (error as any).number = this.id;
      await messageModel.saveErrors([error]);
      await this.commit();

      return;
    }

    this.set({
      lastMessage: messageModel.getNotificationText(),
      lastMessageStatus: 'sending',
      active_at: networkTimestamp,
    });
    await this.commit();

    await this.queueJob(async () => {
      await this.sendMessageJob(messageModel, expireTimer);
    });
  }

  public async bouncyUpdateLastMessage() {
    if (!this.id) {
      return;
    }
    if (!this.get('active_at')) {
      return;
    }
    const messages = await getLastMessagesByConversation(this.id, 1, true);
    const lastMessageModel = messages.at(0);
    const lastMessageJSON = lastMessageModel ? lastMessageModel.toJSON() : null;
    const lastMessageStatusModel = lastMessageModel
      ? lastMessageModel.getMessagePropStatus()
      : undefined;
    const lastMessageUpdate = createLastMessageUpdate({
      currentTimestamp: this.get('active_at'),
      lastMessage: lastMessageJSON,
      lastMessageStatus: lastMessageStatusModel,
      lastMessageNotificationText: lastMessageModel
        ? lastMessageModel.getNotificationText()
        : undefined,
    });
    this.set(lastMessageUpdate);
    await this.commit();
  }

  public async updateExpireTimer(
    providedExpireTimer: number | null,
    providedSource?: string,
    receivedAt?: number, // is set if it comes from outside
    options: {
      fromSync?: boolean;
    } = {}
  ) {
    let expireTimer = providedExpireTimer;
    let source = providedSource;

    _.defaults(options, { fromSync: false });

    if (!expireTimer) {
      expireTimer = 0;
    }
    if (this.get('expireTimer') === expireTimer || (!expireTimer && !this.get('expireTimer'))) {
      return null;
    }

    window?.log?.info("Update conversation 'expireTimer'", {
      id: this.idForLogging(),
      expireTimer,
      source,
    });

    const isOutgoing = Boolean(!receivedAt);

    source = source || UserUtils.getOurPubKeyStrFromCache();

    // When we add a disappearing messages notification to the conversation, we want it
    //   to be above the message that initiated that change, hence the subtraction.
    const timestamp = (receivedAt || Date.now()) - 1;

    this.set({ expireTimer });

    const commonAttributes = {
      flags: SignalService.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
      expirationTimerUpdate: {
        expireTimer,
        source,
        fromSync: options.fromSync,
      },
      expireTimer: 0,
      type: isOutgoing ? 'outgoing' : ('incoming' as MessageModelType),
      destination: this.id,
      recipients: isOutgoing ? this.getRecipients() : undefined,
    };

    let message: MessageModel | undefined;

    if (isOutgoing) {
      message = await this.addSingleOutgoingMessage({
        ...commonAttributes,
        unread: 0,
        sent_at: timestamp,
      });
    } else {
      message = await this.addSingleIncomingMessage({
        ...commonAttributes,
        // Even though this isn't reflected to the user, we want to place the last seen
        //   indicator above it. We set it to 'unread' to trigger that placement.
        unread: 1,
        source,
        sent_at: timestamp,
        received_at: timestamp,
      });
    }

    if (this.isActive()) {
      this.set('active_at', timestamp);
    }

    // tell the UI this conversation was updated
    await this.commit();

    // if change was made remotely, don't send it to the number/group
    if (receivedAt) {
      return message;
    }

    const expireUpdate = {
      identifier: message.id,
      timestamp,
      expireTimer: expireTimer ? expireTimer : (null as number | null),
    };

    if (!expireUpdate.expireTimer) {
      delete expireUpdate.expireTimer;
    }

    if (this.isMe()) {
      const expirationTimerMessage = new ExpirationTimerUpdateMessage(expireUpdate);
      return message.sendSyncMessageOnly(expirationTimerMessage);
    }

    if (this.isPrivate()) {
      const expirationTimerMessage = new ExpirationTimerUpdateMessage(expireUpdate);
      const pubkey = new PubKey(this.get('id'));
      await getMessageQueue().sendToPubKey(pubkey, expirationTimerMessage);
    } else {
      window?.log?.warn('TODO: Expiration update for closed groups are to be updated');
      const expireUpdateForGroup = {
        ...expireUpdate,
        groupId: this.get('id'),
      };

      const expirationTimerMessage = new ExpirationTimerUpdateMessage(expireUpdateForGroup);

      await getMessageQueue().sendToGroup(expirationTimerMessage);
    }
    return message;
  }

  public triggerUIRefresh() {
    updatesToDispatch.set(this.id, this.getConversationModelProps());
    trotthledAllConversationsDispatch();
  }

  public async commit() {
    perfStart(`conversationCommit-${this.attributes.id}`);
    // write to DB
    await updateConversation(this.attributes);
    this.triggerUIRefresh();
    perfEnd(`conversationCommit-${this.attributes.id}`, 'conversationCommit');
  }

  public async addSingleOutgoingMessage(
    messageAttributes: Omit<
      MessageAttributesOptionals,
      'conversationId' | 'source' | 'type' | 'direction' | 'received_at'
    >
  ) {
    return this.addSingleMessage({
      ...messageAttributes,
      conversationId: this.id,
      source: UserUtils.getOurPubKeyStrFromCache(),
      type: 'outgoing',
      direction: 'outgoing',
      received_at: messageAttributes.sent_at, // make sure to set an received_at timestamp for an outgoing message, so the order are right.
    });
  }

  public async addSingleIncomingMessage(
    messageAttributes: Omit<MessageAttributesOptionals, 'conversationId' | 'type' | 'direction'>
  ) {
    return this.addSingleMessage({
      ...messageAttributes,
      conversationId: this.id,
      type: 'incoming',
      direction: 'outgoing',
    });
  }

  public async leaveClosedGroup() {
    if (this.isMediumGroup()) {
      await leaveClosedGroup(this.id);
    } else {
      window?.log?.error('Cannot leave a non-medium group conversation');
      throw new Error(
        'Legacy group are not supported anymore. You need to create this group again.'
      );
    }
  }

  public async markReadBouncy(newestUnreadDate: number, providedOptions: any = {}) {
    const lastReadTimestamp = this.lastReadTimestamp;
    if (newestUnreadDate < lastReadTimestamp) {
      return;
    }

    const options = providedOptions || {};
    _.defaults(options, { sendReadReceipts: true });

    const conversationId = this.id;
    window.Whisper.Notifications.remove(
      window.Whisper.Notifications.where({
        conversationId,
      })
    );
    let allUnreadMessagesInConvo = (await this.getUnread()).models;

    const oldUnreadNowRead = allUnreadMessagesInConvo.filter(
      message => (message.get('received_at') as number) <= newestUnreadDate
    );

    let read = [];

    // Build the list of updated message models so we can mark them all as read on a single sqlite call
    for (const nowRead of oldUnreadNowRead) {
      nowRead.markReadNoCommit(options.readAt);

      const errors = nowRead.get('errors');
      read.push({
        sender: nowRead.get('source'),
        timestamp: nowRead.get('sent_at'),
        hasErrors: Boolean(errors && errors.length),
      });
    }
    const oldUnreadNowReadAttrs = oldUnreadNowRead.map(m => m.attributes);
    if (oldUnreadNowReadAttrs?.length) {
      await saveMessages(oldUnreadNowReadAttrs);
    }
    const allProps: Array<MessageModelPropsWithoutConvoProps> = [];

    for (const nowRead of oldUnreadNowRead) {
      allProps.push(nowRead.getMessageModelProps());
    }

    if (allProps.length) {
      window.inboxStore?.dispatch(conversationActions.messagesChanged(allProps));
    }
    // Some messages we're marking read are local notifications with no sender
    read = _.filter(read, m => Boolean(m.sender));
    const realUnreadCount = await this.getUnreadCount();
    if (read.length === 0) {
      const cachedUnreadCountOnConvo = this.get('unreadCount');
      if (cachedUnreadCountOnConvo !== read.length) {
        // reset the unreadCount on the convo to the real one coming from markRead messages on the db
        this.set({ unreadCount: realUnreadCount });
        await this.commit();
      } else {
        // window?.log?.info('markRead(): nothing newly read.');
      }
      return;
    }

    allUnreadMessagesInConvo = allUnreadMessagesInConvo.filter((m: any) => Boolean(m.isIncoming()));

    this.set({ unreadCount: realUnreadCount });

    const mentionRead = (() => {
      const stillUnread = allUnreadMessagesInConvo.filter(
        (m: any) => m.get('received_at') > newestUnreadDate
      );
      const ourNumber = UserUtils.getOurPubKeyStrFromCache();
      return !stillUnread.some(m => m.get('body')?.indexOf(`@${ourNumber}`) !== -1);
    })();

    if (mentionRead) {
      this.set({ mentionedUs: false });
    }

    await this.commit();

    // If a message has errors, we don't want to send anything out about it.
    //   read syncs - let's wait for a client that really understands the message
    //      to mark it read. we'll mark our local error read locally, though.
    //   read receipts - here we can run into infinite loops, where each time the
    //      conversation is viewed, another error message shows up for the contact
    read = read.filter(item => !item.hasErrors);

    if (this.isPublic()) {
      return;
    }
    if (this.isPrivate() && read.length && options.sendReadReceipts) {
      window?.log?.info(
        `Sending ${read.length} read receipts?`,
        window.storage.get(SettingsKey.settingsReadReceipt) || false
      );
      if (window.storage.get(SettingsKey.settingsReadReceipt)) {
        const timestamps = _.map(read, 'timestamp').filter(t => !!t) as Array<number>;
        const receiptMessage = new ReadReceiptMessage({
          timestamp: Date.now(),
          timestamps,
        });

        const device = new PubKey(this.id);
        await getMessageQueue().sendToPubKey(device, receiptMessage);
      }
    }
  }

  public async setNickname(nickname?: string) {
    if (!this.isPrivate()) {
      window.log.info('cannot setNickname to a non private conversation.');
      return;
    }
    const trimmed = nickname && nickname.trim();
    if (this.get('nickname') === trimmed) {
      return;
    }
    // make sure to save the lokiDisplayName as name in the db. so a search of conversation returns it.
    // (we look for matches in name too)
    const realUserName = this.getLokiProfile()?.displayName;

    if (!trimmed || !trimmed.length) {
      this.set({ nickname: undefined, name: realUserName });
    } else {
      this.set({ nickname: trimmed, name: realUserName });
    }

    await this.commit();

    await this.updateProfileName();
  }
  public async setLokiProfile(newProfile: {
    displayName?: string | null;
    avatar?: string;
    avatarHash?: string;
  }) {
    if (!_.isEqual(this.get('profile'), newProfile)) {
      this.set({ profile: newProfile });
      await this.commit();
    }

    // a user cannot remove an avatar. Only change it
    // if you change this behavior, double check all setLokiProfile calls (especially the one in EditProfileDialog)
    if (newProfile.avatar) {
      await this.setProfileAvatar({ path: newProfile.avatar }, newProfile.avatarHash);
    }

    await this.updateProfileName();
  }
  public async updateProfileName() {
    // Prioritise nickname over the profile display name
    const nickname = this.getNickname();
    const displayName = this.getLokiProfile()?.displayName;

    const profileName = nickname || displayName || null;
    await this.setProfileName(profileName);
  }
  public getLokiProfile() {
    return this.get('profile');
  }
  public getNickname() {
    return this.get('nickname');
  }

  public isAdmin(pubKey?: string) {
    if (!this.isPublic() && !this.isGroup()) {
      return false;
    }
    if (!pubKey) {
      throw new Error('isAdmin() pubKey is falsy');
    }
    const groupAdmins = this.getGroupAdmins();
    return Array.isArray(groupAdmins) && groupAdmins.includes(pubKey);
  }
  // SIGNAL PROFILES
  public async getProfiles() {
    // request all conversation members' keys
    let ids = [];
    if (this.isPrivate()) {
      ids = [this.id];
    } else {
      ids = this.get('members');
    }
    return Promise.all(_.map(ids, this.getProfile));
  }

  // This function is wrongly named by signal
  // This is basically an `update` function and thus we have overwritten it with such
  public async getProfile(id: string) {
    const c = await getConversationController().getOrCreateAndWait(
      id,
      ConversationTypeEnum.PRIVATE
    );

    // We only need to update the profile as they are all stored inside the conversation
    await c.updateProfileName();
  }
  public async setProfileName(name: string) {
    const profileName = this.get('profileName');
    if (profileName !== name) {
      this.set({ profileName: name });
      await this.commit();
    }
  }

  public async setIsPinned(value: boolean) {
    if (value !== this.isPinned()) {
      this.set({
        isPinned: value,
      });
      await this.commit();
    }
  }

  public async setIsApproved(value: boolean, shouldCommit: boolean = true) {
    if (value !== this.isApproved()) {
      window?.log?.info(`Setting ${this.attributes.profileName} isApproved to:: ${value}`);
      this.set({
        isApproved: value,
      });

      if (!this.isApproved() && value) {
        // if convo hasn't been approved until now, send approval msg
        this.sendMessageRequestResponse(true);
        void forceSyncConfigurationNowIfNeeded();
      }

      if (shouldCommit) {
        await this.commit();
      }
    }
  }

  public async setDidApproveMe(value: boolean, shouldCommit: boolean = true) {
    if (value !== this.didApproveMe()) {
      window?.log?.info(`Setting ${this.attributes.profileName} didApproveMe to:: ${value}`);
      this.set({
        didApproveMe: value,
      });

      if (shouldCommit) {
        await this.commit();
      }
    }
  }

  public async setGroupName(name: string) {
    const profileName = this.get('name');
    if (profileName !== name) {
      this.set({ name });
      await this.commit();
    }
  }
  public async setSubscriberCount(count: number) {
    if (this.get('subscriberCount') !== count) {
      this.set({ subscriberCount: count });
      await this.commit();
    }
    // Not sure if we care about updating the database
  }

  public async setProfileAvatar(avatar: null | { path: string }, avatarHash?: string) {
    const profileAvatar = this.get('avatar');
    const existingHash = this.get('avatarHash');
    let shouldCommit = false;
    if (!_.isEqual(profileAvatar, avatar)) {
      this.set({ avatar });
      shouldCommit = true;
    }

    if (existingHash !== avatarHash) {
      this.set({ avatarHash });
      shouldCommit = true;
    }

    if (shouldCommit) {
      await this.commit();
    }
  }
  /**
   * profileKey MUST be a hex string
   * @param profileKey MUST be a hex string
   */
  public async setProfileKey(profileKey?: Uint8Array, autoCommit = true) {
    if (!profileKey) {
      return;
    }

    const profileKeyHex = toHex(profileKey);

    // profileKey is a string so we can compare it directly
    if (this.get('profileKey') !== profileKeyHex) {
      this.set({
        profileKey: profileKeyHex,
      });

      if (autoCommit) {
        await this.commit();
      }
    }
  }

  public hasMember(pubkey: string) {
    return _.includes(this.get('members'), pubkey);
  }
  // returns true if this is a closed/medium or open group
  public isGroup() {
    return this.get('type') === ConversationTypeEnum.GROUP;
  }

  public async removeMessage(messageId: any) {
    await dataRemoveMessage(messageId);
    this.updateLastMessage();

    window.inboxStore?.dispatch(
      conversationActions.messageDeleted({
        conversationKey: this.id,
        messageId,
      })
    );
  }

  public getName() {
    if (this.isPrivate()) {
      return this.get('name');
    }
    return this.get('name') || window.i18n('unknown');
  }

  public isPinned() {
    return Boolean(this.get('isPinned'));
  }

  public didApproveMe() {
    return Boolean(this.get('didApproveMe'));
  }

  public isApproved() {
    return Boolean(this.get('isApproved'));
  }

  public getTitle() {
    if (this.isPrivate()) {
      const profileName = this.getProfileName();
      const number = this.getNumber();
      const name = profileName ? `${profileName} (${PubKey.shorten(number)})` : number;

      return this.get('name') || name;
    }
    return this.get('name') || 'Unknown group';
  }

  /**
   * For a private convo, returns the loki profilename if set, or a shortened
   * version of the contact pubkey.
   * Throws an error if called on a group convo.
   *
   */
  public getContactProfileNameOrShortenedPubKey() {
    if (!this.isPrivate()) {
      throw new Error(
        'getContactProfileNameOrShortenedPubKey() cannot be called with a non private convo.'
      );
    }

    const profileName = this.get('profileName');
    const pubkey = this.id;
    if (UserUtils.isUsFromCache(pubkey)) {
      return window.i18n('you');
    }
    return profileName || PubKey.shorten(pubkey);
  }

  /**
   * For a private convo, returns the loki profilename if set, or a full length
   * version of the contact pubkey.
   * Throws an error if called on a group convo.
   */
  public getContactProfileNameOrFullPubKey() {
    if (!this.isPrivate()) {
      throw new Error(
        'getContactProfileNameOrFullPubKey() cannot be called with a non private convo.'
      );
    }
    const profileName = this.get('profileName');
    const pubkey = this.id;
    if (UserUtils.isUsFromCache(pubkey)) {
      return window.i18n('you');
    }
    return profileName || pubkey;
  }

  public getProfileName() {
    if (this.isPrivate()) {
      return this.get('profileName');
    }
    return undefined;
  }

  public getNumber() {
    if (!this.isPrivate()) {
      return '';
    }
    return this.id;
  }

  public isPrivate() {
    return this.get('type') === ConversationTypeEnum.PRIVATE;
  }

  public getAvatarPath() {
    const avatar = this.get('avatar') || this.get('profileAvatar');
    if (typeof avatar === 'string') {
      return avatar;
    }

    if (typeof avatar?.path === 'string') {
      return getAbsoluteAttachmentPath(avatar.path);
    }

    return null;
  }

  public async getNotificationIcon() {
    const avatarUrl = this.getAvatarPath();
    const noIconUrl = 'images/session/session_icon_32.png';
    if (avatarUrl) {
      const decryptedAvatarUrl = await getDecryptedMediaUrl(avatarUrl, IMAGE_JPEG, true);

      if (!decryptedAvatarUrl) {
        window.log.warn('Could not decrypt avatar stored locally for getNotificationIcon..');
        return noIconUrl;
      }
      return decryptedAvatarUrl;
    } else {
      return noIconUrl;
    }
  }

  public async notify(message: MessageModel) {
    if (!message.isIncoming()) {
      return;
    }
    const conversationId = this.id;

    if (!this.isApproved()) {
      window?.log?.info('notification cancelled for unapproved convo', this.idForLogging());
      return;
    }

    // make sure the notifications are not muted for this convo (and not the source convo)
    const convNotif = this.get('triggerNotificationsFor');
    if (convNotif === 'disabled') {
      window?.log?.info('notifications disabled for convo', this.idForLogging());
      return;
    }
    if (convNotif === 'mentions_only') {
      // check if the message has ourselves as mentions
      const regex = new RegExp(`@${PubKey.regexForPubkeys}`, 'g');
      const text = message.get('body');
      const mentions = text?.match(regex) || ([] as Array<string>);
      const mentionMe = mentions && mentions.some(m => UserUtils.isUsFromCache(m.slice(1)));

      const quotedMessageAuthor = message.get('quote')?.author;

      const isReplyToOurMessage =
        quotedMessageAuthor && UserUtils.isUsFromCache(quotedMessageAuthor);
      if (!mentionMe && !isReplyToOurMessage) {
        window?.log?.info(
          'notifications disabled for non mentions or reply for convo',
          conversationId
        );

        return;
      }
    }

    const convo = await getConversationController().getOrCreateAndWait(
      message.get('source'),
      ConversationTypeEnum.PRIVATE
    );

    const iconUrl = await this.getNotificationIcon();

    const messageJSON = message.toJSON();
    const messageSentAt = messageJSON.sent_at;
    const messageId = message.id;
    const isExpiringMessage = this.isExpiringMessage(messageJSON);

    // window?.log?.info('Add notification', {
    //   conversationId: this.idForLogging(),
    //   isExpiringMessage,
    //   messageSentAt,
    // });
    window.Whisper.Notifications.add({
      conversationId,
      iconUrl,
      isExpiringMessage,
      message: message.getNotificationText(),
      messageId,
      messageSentAt,
      title: convo.getTitle(),
    });
  }

  public async notifyIncomingCall() {
    if (!this.isPrivate()) {
      window?.log?.info('notifyIncomingCall: not a private convo', this.idForLogging());
      return;
    }
    const conversationId = this.id;

    // make sure the notifications are not muted for this convo (and not the source convo)
    const convNotif = this.get('triggerNotificationsFor');
    if (convNotif === 'disabled') {
      window?.log?.info(
        'notifyIncomingCall: notifications disabled for convo',
        this.idForLogging()
      );
      return;
    }

    const now = Date.now();
    const iconUrl = await this.getNotificationIcon();

    window.Whisper.Notifications.add({
      conversationId,
      iconUrl,
      isExpiringMessage: false,
      message: window.i18n('incomingCallFrom', this.getTitle()),
      messageSentAt: now,
      title: this.getTitle(),
    });
  }

  public async notifyTyping({ isTyping, sender }: any) {
    // We don't do anything with typing messages from our other devices
    if (UserUtils.isUsFromCache(sender)) {
      return;
    }

    // typing only works for private chats for now
    if (!this.isPrivate()) {
      return;
    }

    const wasTyping = !!this.typingTimer;
    if (this.typingTimer) {
      global.clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }

    // Note: We trigger two events because:
    //   'change' causes a re-render of this conversation's list item in the left pane

    if (isTyping) {
      this.typingTimer = global.setTimeout(
        this.clearContactTypingTimer.bind(this, sender),
        15 * 1000
      );

      if (!wasTyping) {
        // User was not previously typing before. State change!
        await this.commit();
      }
    } else {
      this.typingTimer = null;
      if (wasTyping) {
        // User was previously typing, and is no longer. State change!
        await this.commit();
      }
    }
  }

  private async addSingleMessage(messageAttributes: MessageAttributesOptionals) {
    const model = new MessageModel(messageAttributes);

    const isMe = messageAttributes.source === UserUtils.getOurPubKeyStrFromCache();

    if (
      isMe &&
      window.lokiFeatureFlags.useMessageRequests &&
      window.inboxStore?.getState().userConfig.messageRequests
    ) {
      await this.setIsApproved(true);
    }

    // no need to trigger a UI update now, we trigger a messagesAdded just below
    const messageId = await model.commit(false);
    model.set({ id: messageId });

    await model.setToExpire();

    const messageModelProps = model.getMessageModelProps();
    window.inboxStore?.dispatch(conversationActions.messagesChanged([messageModelProps]));
    const unreadCount = await this.getUnreadCount();
    this.set({ unreadCount });
    this.updateLastMessage();

    await this.commit();
    return model;
  }

  private async clearContactTypingTimer(_sender: string) {
    if (!!this.typingTimer) {
      global.clearTimeout(this.typingTimer);
      this.typingTimer = null;

      // User was previously typing, but timed out or we received message. State change!
      await this.commit();
    }
  }

  private isExpiringMessage(json: any) {
    if (json.type === 'incoming') {
      return false;
    }

    const { expireTimer } = json;

    return isFinite(expireTimer) && expireTimer > 0;
  }

  private shouldDoTyping() {
    // for typing to happen, this must be a private unblocked active convo, and the settings to be on
    if (
      !this.isActive() ||
      !window.storage.get(SettingsKey.settingsTypingIndicator) ||
      this.isBlocked() ||
      !this.isPrivate()
    ) {
      return false;
    }
    const msgRequestsEnabled =
      window.lokiFeatureFlags.useMessageRequests &&
      window.inboxStore?.getState().userConfig.messageRequests;

    // if msg requests are unused, we have to send typing (this is already a private active unblocked convo)
    if (!msgRequestsEnabled) {
      return true;
    }
    // with message requests in use, we just need to check for isApproved
    return Boolean(this.get('isApproved'));
  }

  private async bumpTyping() {
    if (!this.shouldDoTyping()) {
      return;
    }

    if (!this.typingRefreshTimer) {
      const isTyping = true;
      this.setTypingRefreshTimer();
      this.sendTypingMessage(isTyping);
    }

    this.setTypingPauseTimer();
  }

  private setTypingRefreshTimer() {
    if (this.typingRefreshTimer) {
      global.clearTimeout(this.typingRefreshTimer);
    }
    this.typingRefreshTimer = global.setTimeout(this.onTypingRefreshTimeout.bind(this), 10 * 1000);
  }

  private onTypingRefreshTimeout() {
    const isTyping = true;
    this.sendTypingMessage(isTyping);

    // This timer will continue to reset itself until the pause timer stops it
    this.setTypingRefreshTimer();
  }

  private setTypingPauseTimer() {
    if (this.typingPauseTimer) {
      global.clearTimeout(this.typingPauseTimer);
    }
    this.typingPauseTimer = global.setTimeout(this.onTypingPauseTimeout.bind(this), 10 * 1000);
  }

  private onTypingPauseTimeout() {
    const isTyping = false;
    this.sendTypingMessage(isTyping);

    this.clearTypingTimers();
  }

  private clearTypingTimers() {
    if (this.typingPauseTimer) {
      global.clearTimeout(this.typingPauseTimer);
      this.typingPauseTimer = null;
    }
    if (this.typingRefreshTimer) {
      global.clearTimeout(this.typingRefreshTimer);
      this.typingRefreshTimer = null;
    }
  }

  private sendTypingMessage(isTyping: boolean) {
    if (!this.isPrivate()) {
      return;
    }

    const recipientId = this.id;

    if (!recipientId) {
      throw new Error('Need to provide either recipientId');
    }

    if (this.isMe()) {
      // note to self
      return;
    }

    const typingParams = {
      timestamp: Date.now(),
      isTyping,
      typingTimestamp: Date.now(),
    };
    const typingMessage = new TypingMessage(typingParams);

    // send the message to a single recipient if this is a session chat
    const device = new PubKey(recipientId);
    getMessageQueue()
      .sendToPubKey(device, typingMessage)
      .catch(window?.log?.error);
  }
}

const trotthledAllConversationsDispatch = _.throttle(() => {
  if (updatesToDispatch.size === 0) {
    return;
  }
  window.inboxStore?.dispatch(conversationsChanged([...updatesToDispatch.values()]));

  updatesToDispatch.clear();
}, 500);

const updatesToDispatch: Map<string, ReduxConversationType> = new Map();

export class ConversationCollection extends Backbone.Collection<ConversationModel> {
  constructor(models?: Array<ConversationModel>) {
    super(models);
    this.comparator = (m: ConversationModel) => {
      return -m.get('active_at');
    };
  }
}
ConversationCollection.prototype.model = ConversationModel;
