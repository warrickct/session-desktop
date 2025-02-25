import classNames from 'classnames';
import React, { useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import _ from 'underscore';
import { MessageRenderingProps, QuoteClickOptions } from '../../../models/messageType';
import { toggleSelectedMessageId } from '../../../state/ducks/conversations';
import {
  getMessageContentWithStatusesSelectorProps,
  isMessageSelectionMode,
} from '../../../state/selectors/conversations';
import { MessageAuthorText } from './MessageAuthorText';
import { MessageContent } from './MessageContent';
import { MessageContextMenu } from './MessageContextMenu';
import { MessageStatus } from './MessageStatus';

export type MessageContentWithStatusSelectorProps = Pick<
  MessageRenderingProps,
  'direction' | 'isDeleted'
>;

type Props = {
  messageId: string;
  onQuoteClick: (quote: QuoteClickOptions) => void;
  ctxMenuID: string;
  isDetailView?: boolean;
};

export const MessageContentWithStatuses = (props: Props) => {
  const contentProps = useSelector(state =>
    getMessageContentWithStatusesSelectorProps(state as any, props.messageId)
  );
  const dispatch = useDispatch();

  const multiSelectMode = useSelector(isMessageSelectionMode);

  const onClickOnMessageOuterContainer = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const selection = window.getSelection();
      // Text is being selected
      if (selection && selection.type === 'Range') {
        return;
      }

      // User clicked on message body
      const target = event.target as HTMLDivElement;
      if (
        (!multiSelectMode && target.className === 'text-selectable') ||
        window.contextMenuShown ||
        props?.isDetailView
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (messageId) {
        dispatch(toggleSelectedMessageId(messageId));
      }
    },
    [window.contextMenuShown, props?.messageId, multiSelectMode, props?.isDetailView]
  );

  const { messageId, onQuoteClick, ctxMenuID, isDetailView } = props;
  if (!contentProps) {
    return null;
  }
  const { direction, isDeleted } = contentProps;
  const isIncoming = direction === 'incoming';

  return (
    <div
      className={classNames('module-message', `module-message--${direction}`)}
      role="button"
      onClick={onClickOnMessageOuterContainer}
    >
      <MessageStatus messageId={messageId} isCorrectSide={isIncoming} />
      <div>
        <MessageAuthorText messageId={messageId} />

        <MessageContent
          messageId={messageId}
          isDetailView={isDetailView}
          onQuoteClick={onQuoteClick}
        />
      </div>
      <MessageStatus messageId={messageId} isCorrectSide={!isIncoming} />
      {!isDeleted && <MessageContextMenu messageId={messageId} contextMenuId={ctxMenuID} />}
    </div>
  );
};
