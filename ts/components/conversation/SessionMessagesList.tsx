import React, { useLayoutEffect } from 'react';
import { useSelector } from 'react-redux';
// tslint:disable-next-line: no-submodule-imports
import useKey from 'react-use/lib/useKey';
import {
  PropsForDataExtractionNotification,
  PropsForMessageRequestResponse,
  QuoteClickOptions,
} from '../../models/messageType';
import {
  PropsForCallNotification,
  PropsForExpirationTimer,
  PropsForGroupInvitation,
  PropsForGroupUpdate,
} from '../../state/ducks/conversations';
import { getSortedMessagesTypesOfSelectedConversation } from '../../state/selectors/conversations';
import { GroupUpdateMessage } from './message/message-item/GroupUpdateMessage';
import { DataExtractionNotification } from './message/message-item/DataExtractionNotification';
import { MessageDateBreak } from './message/message-item/DateBreak';
import { GroupInvitation } from './message/message-item/GroupInvitation';
import { Message } from './message/message-item/Message';
import { CallNotification } from './message/message-item/notification-bubble/CallNotification';

import { SessionLastSeenIndicator } from './SessionLastSeenIndicator';
import { TimerNotification } from './TimerNotification';
import { DataExtractionNotification } from './message/message-item/DataExtractionNotification';

function isNotTextboxEvent(e: KeyboardEvent) {
  return (e?.target as any)?.type === undefined;
}

export const SessionMessagesList = (props: {
  scrollToQuoteMessage: (options: QuoteClickOptions) => Promise<void>;
  onPageUpPressed: () => void;
  onPageDownPressed: () => void;
  onHomePressed: () => void;
  onEndPressed: () => void;
}) => {
  const messagesProps = useSelector(getSortedMessagesTypesOfSelectedConversation);

  useKey('PageUp', () => {
    props.onPageUpPressed();
  });

  useKey('PageDown', () => {
    props.onPageDownPressed();
  });

  useKey('Home', e => {
    if (isNotTextboxEvent(e)) {
      props.onHomePressed();
    }
  });

  useKey('End', e => {
    if (isNotTextboxEvent(e)) {
      props.onEndPressed();
    }
  });

  return (
    <>
      {messagesProps.map(messageProps => {
        const messageId = messageProps.message.props.messageId;
        const unreadIndicator = messageProps.showUnreadIndicator ? (
          <SessionLastSeenIndicator key={`unread-indicator-${messageId}`} messageId={messageId} />
        ) : null;

        const dateBreak =
          messageProps.showDateBreak !== undefined ? (
            <MessageDateBreak
              key={`date-break-${messageId}`}
              timestamp={messageProps.showDateBreak}
              messageId={messageId}
            />
          ) : null;
        if (messageProps.message?.messageType === 'group-notification') {
          const msgProps = messageProps.message.props as PropsForGroupUpdate;
          return [<GroupUpdateMessage key={messageId} {...msgProps} />, dateBreak, unreadIndicator];
        }

        if (messageProps.message?.messageType === 'group-invitation') {
          const msgProps = messageProps.message.props as PropsForGroupInvitation;
          return [<GroupInvitation key={messageId} {...msgProps} />, dateBreak, unreadIndicator];
        }

        if (messageProps.message?.messageType === 'message-request-response') {
          const msgProps = messageProps.message.props as PropsForMessageRequestResponse;

          return [
            <MessageRequestResponse key={messageId} {...msgProps} />,
            dateBreak,
            unreadIndicator,
          ];
        }

        if (messageProps.message?.messageType === 'data-extraction') {
          const msgProps = messageProps.message.props as PropsForDataExtractionNotification;

          return [
            <DataExtractionNotification key={messageId} {...msgProps} />,
            dateBreak,
            unreadIndicator,
          ];
        }

        if (messageProps.message?.messageType === 'timer-notification') {
          const msgProps = messageProps.message.props as PropsForExpirationTimer;

          return [<TimerNotification key={messageId} {...msgProps} />, dateBreak, unreadIndicator];
        }

        if (messageProps.message?.messageType === 'call-notification') {
          const msgProps = messageProps.message.props as PropsForCallNotification;

          return [<CallNotification key={messageId} {...msgProps} />, dateBreak, unreadIndicator];
        }

        if (!messageProps) {
          return null;
        }

        return [<Message messageId={messageId} key={messageId} />, dateBreak, unreadIndicator];
      })}
    </>
  );
};
