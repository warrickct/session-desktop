import _ from 'lodash';
import { getMessageById, Snode } from '../../data/data';
import { storeOnNode } from '../snode_api/SNodeAPI';
import { getSwarmFor } from '../snode_api/snodePool';
// import { UserUtils } from '../utils';
import { firstTrue } from '../utils/Promise';

const DEFAULT_CONNECTIONS = 3;

/**
 * Refactor note: We should really clean this up ... it's very messy
 *
 * We need to split it into 2 sends:
 *  - Snodes
 *  - Open Groups
 *
 * Mikunj:
 *  Temporarily i've made it so `MessageSender` handles open group sends and calls this function for regular sends.
 */
export async function sendMessage(
  pubKey: string,
  data: Uint8Array,
  messageTimeStamp: number,
  ttl: number,
  options: {
    isPublic?: boolean;
    messageIdForHash?: string;
    isSyncMessage?: boolean;
  } = {}
): Promise<void> {
  const { isPublic = false, isSyncMessage = false, messageIdForHash } = options;

  if (isPublic) {
    window?.log?.warn('this sendMessage() should not be called anymore with an open group message');
    return;
  }

  const data64 = window.dcodeIO.ByteBuffer.wrap(data).toString('base64');

  // Using timestamp as a unique identifier
  const swarm = await getSwarmFor(pubKey);

  // send parameters
  const params = {
    pubKey,
    ttl: `${ttl}`,
    timestamp: `${messageTimeStamp}`,
    data: data64,
  };

  const usedNodes = _.slice(swarm, 0, DEFAULT_CONNECTIONS);

  const promises = usedNodes.map(async usedNode => {
    // TODO: Revert back to using snode address instead of IP
    // No pRetry here as if this is a bad path it will be handled and retried in lokiOnionFetch.
    // the only case we could care about a retry would be when the usedNode is not correct,
    // but considering we trigger this request with a few snode in //, this should be fine.
    const successfullSendHash = await storeOnNode(usedNode, params, options.messageIdForHash);
    if (successfullSendHash) {
      return { usedNode, successfullSendHash };
    }
    // should we mark snode as bad if it can't store our message?
    return undefined;
  });

  let sendSuccess: { usedNode: Snode; successfullSendHash: string } | undefined;
  try {
    sendSuccess = await firstTrue(promises);
  } catch (e) {
    const snodeStr = sendSuccess?.usedNode
      ? `${sendSuccess.usedNode.ip}:${sendSuccess.usedNode.port}`
      : 'null';
    window?.log?.warn(
      `loki_message:::sendMessage - ${e.code} ${e.message} to ${pubKey} via snode:${snodeStr}`
    );
    throw e;
  }
  if (!usedNodes || usedNodes.length === 0) {
    throw new window.textsecure.EmptySwarmError(pubKey, 'Ran out of swarm nodes to query');
  }

  // If message also has a sync message, save that hash. Otherwise save the hash from the regular message send i.e. only closed groups in this case.
  if (messageIdForHash && 
    (isSyncMessage)) {
    console.warn('message contains hash and message --  saving with hash');
    const message = await getMessageById(messageIdForHash);
    if (message) {
      await message.updateMessageHash(sendSuccess.successfullSendHash);
      await message.commit();
      console.warn(`updated message ${message.get('id')} with hash: ${message.get('messageHash')}`);
    }
  }
  window?.log?.info(
    `loki_message:::sendMessage - Successfully stored message to ${pubKey} via ${sendSuccess.usedNode.ip}:${sendSuccess.usedNode.port}`
  );
}
