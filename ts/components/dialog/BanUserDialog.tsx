import React, { useState } from 'react';
import { PubKey } from '../../session/types';
import { ToastUtils } from '../../session/utils';
import { Flex } from '../basic/Flex';
import { useDispatch } from 'react-redux';
import { updateBanUserModal, updateConfirmModal } from '../../state/ducks/modalDialog';
import { SpacerSM } from '../basic/Text';
import { getConversationController } from '../../session/conversations/ConversationController';
import { ApiV2 } from '../../session/apis/open_group_api/opengroupV2';
import { SessionWrapperModal } from '../SessionWrapperModal';
import { SessionSpinner } from '../basic/SessionSpinner';
import { SessionButton, SessionButtonColor, SessionButtonType } from '../basic/SessionButton';

type Props = {
  conversationId: string;
};

export const BanUserDialog = (props: Props) => {
  const { conversationId } = props;

  const dispatch = useDispatch();
  const convo = getConversationController().get(conversationId);

  const [inputBoxValue, setInputBoxValue] = useState('');
  const [banningInProgress, setBanningInProgress] = useState(false);

  /**
   * Bans a user from a group
   * @param deleteAll Delete all messages for that user in the group
   */
  const banUser = async (deleteAll: boolean = false) => {
    // if we don't have valid data entered by the user
    const pubkey = PubKey.from(inputBoxValue);
    if (!pubkey) {
      window.log.info('invalid pubkey for banning user:', inputBoxValue);
      ToastUtils.pushInvalidPubKey();
      return;
    }

    window?.log?.info(`asked to ban user: ${pubkey.key}`);

    try {
      setBanningInProgress(true);
      let isBanned: any;
      // this is a v2 opengroup
      const roomInfos = convo.toOpenGroupV2();
      isBanned = await ApiV2.banUser(pubkey, roomInfos, deleteAll);

      if (!isBanned) {
        window?.log?.warn('failed to ban user:', isBanned);

        ToastUtils.pushUserBanFailure();
      } else {
        window?.log?.info(`${pubkey.key} ban user...`);
        ToastUtils.pushUserBanSuccess();

        // clear input box
        setInputBoxValue('');
      }
    } catch (e) {
      window?.log?.error('Got error while banning user:', e);
    } finally {
      setBanningInProgress(false);
    }
  };

  const { i18n } = window;
  const chatName = convo.get('name');

  const title = `${window.i18n('banUser')}: ${chatName}`;

  const onPubkeyBoxChanges = (e: any) => {
    const val = e.target.value;
    setInputBoxValue(val);
  };

  /**
   * Starts procedure for banning user and all their messages using dialog
   */
  const startBanAndDeleteAllSequence = async () => {
    if (!inputBoxValue.length) {
      window?.log?.error('No user key entered to start ban user and all messages dialog.');
      return;
    }

    dispatch(
      updateConfirmModal({
        title: i18n('banAndDeleteAllDialogTitle'),
        okText: i18n('banUserAndDeleteAll'),
        message: i18n('banUserAndDeleteAllConfirm'),
        onClickOk: async () => {
          await banUser(true);
        },
        onClickCancel: () => {
          dispatch(updateConfirmModal(null));
        },
      })
    );
  };

  return (
    <SessionWrapperModal
      showExitIcon={true}
      title={title}
      onClose={() => {
        dispatch(updateBanUserModal(null));
      }}
    >
      <Flex container={true} flexDirection="column" alignItems="center">
        <p>{window.i18n('banUser')}:</p>
        <input
          type="text"
          className="module-main-header__search__input"
          placeholder={i18n('enterSessionID')}
          dir="auto"
          onChange={onPubkeyBoxChanges}
          disabled={banningInProgress}
          value={inputBoxValue}
        />
        <SessionButton
          buttonType={SessionButtonType.Brand}
          buttonColor={SessionButtonColor.Primary}
          onClick={banUser}
          text={window.i18n('banUser')}
          disabled={banningInProgress}
        />
        <SpacerSM />
        <SessionButton
          buttonType={SessionButtonType.Brand}
          buttonColor={SessionButtonColor.Primary}
          onClick={startBanAndDeleteAllSequence}
          text={i18n('banUserAndDeleteAll')}
          disabled={banningInProgress}
        />

        <SessionSpinner loading={banningInProgress} />
      </Flex>
    </SessionWrapperModal>
  );
};
