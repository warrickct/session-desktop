import React from 'react';
import classNames from 'classnames';

import { Avatar, AvatarSize } from './Avatar';
import { MessageBodyHighlight } from './MessageBodyHighlight';
import { Timestamp } from './conversation/Timestamp';
import { ContactName } from './conversation/ContactName';

import {
  FindAndFormatContactType,
  openConversationWithMessages,
} from '../state/ducks/conversations';
import { getOurPubKeyStrFromCache } from '../session/utils/User';

type PropsHousekeeping = {
  isSelected?: boolean;
};

export type PropsForSearchResults = {
  from: FindAndFormatContactType;
  to: FindAndFormatContactType;
  id: string;
  conversationId: string;
  destination: string;
  source: string;

  snippet?: string; //not sure about the type of snippet
  receivedAt?: number;
};

type Props = PropsForSearchResults & PropsHousekeeping;

const FromName = (props: { source: string; destination: string }) => {
  const { source, destination } = props;

  const isNoteToSelf = destination === getOurPubKeyStrFromCache() && source === destination;

  if (isNoteToSelf) {
    return (
      <span className="module-message-search-result__header__name">
        {window.i18n('noteToSelf')}
      </span>
    );
  }

  if (source === getOurPubKeyStrFromCache()) {
    return <span className="module-message-search-result__header__name">{window.i18n('you')}</span>;
  }

  return (
    // tslint:disable: use-simple-attributes
    <ContactName
      pubkey={source}
      module="module-message-search-result__header__name"
      shouldShowPubkey={false}
    />
  );
};

const From = (props: { source: string; destination: string }) => {
  const { source, destination } = props;
  const fromName = <FromName source={source} destination={destination} />;

  const ourKey = getOurPubKeyStrFromCache();

  if (destination !== ourKey) {
    return (
      <div className="module-message-search-result__header__from">
        {fromName} {window.i18n('to')}{' '}
        <span className="module-mesages-search-result__header__group">
          <ContactName pubkey={destination} shouldShowPubkey={false} />
        </span>
      </div>
    );
  }

  return <div className="module-message-search-result__header__from">{fromName}</div>;
};

const AvatarItem = (props: { source: string }) => {
  const { source } = props;
  return <Avatar size={AvatarSize.S} pubkey={source} />;
};

export const MessageSearchResult = (props: Props) => {
  const { isSelected, id, conversationId, receivedAt, snippet, destination, source } = props;

  if (!destination || !source) {
    return null;
  }

  return (
    <div
      role="button"
      onClick={() => {
        openConversationWithMessages({
          conversationKey: conversationId,
          messageId: id,
        });
      }}
      className={classNames(
        'module-message-search-result',
        isSelected ? 'module-message-search-result--is-selected' : null
      )}
    >
      <AvatarItem source={source} />
      <div className="module-message-search-result__text">
        <div className="module-message-search-result__header">
          <From source={source} destination={destination} />
          <div className="module-message-search-result__header__timestamp">
            <Timestamp timestamp={receivedAt} />
          </div>
        </div>
        <div className="module-message-search-result__body">
          <MessageBodyHighlight text={snippet || ''} />
        </div>
      </div>
    </div>
  );
};
