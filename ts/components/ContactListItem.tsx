import React from 'react';
import classNames from 'classnames';

import { Avatar, AvatarSize } from './Avatar';
import { Emojify } from './conversation/Emojify';

interface Props {
  pubkey: string;
  isMe?: boolean;
  name?: string;
  profileName?: string;
  avatarPath?: string;
  onClick?: () => void;
}

export class ContactListItem extends React.Component<Props> {
  public renderAvatar() {
    const { avatarPath, name, pubkey, profileName } = this.props;

    const userName = name || profileName || pubkey;

    return <Avatar avatarPath={avatarPath} name={userName} size={AvatarSize.S} pubkey={pubkey} />;
  }

  public render() {
    const { name, onClick, isMe, pubkey, profileName } = this.props;

    const title = name ? name : pubkey;
    const displayName = isMe ? window.i18n('me') : title;

    const profileElement =
      !isMe && profileName && !name ? (
        <span className="module-contact-list-item__text__profile-name">
          ~
          <Emojify text={profileName} key={`emojify-list-item-${pubkey}`} />
        </span>
      ) : null;

    return (
      <div
        role="button"
        onClick={onClick}
        className={classNames(
          'module-contact-list-item',
          onClick ? 'module-contact-list-item--with-click-handler' : null
        )}
      >
        {this.renderAvatar()}
        <div className="module-contact-list-item__text">
          <div className="module-contact-list-item__text__name">
            <Emojify text={displayName} /> {profileElement}
          </div>
        </div>
      </div>
    );
  }
}
