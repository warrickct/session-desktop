const path = require('path');
const fs = require('fs');
const rimraf = require('rimraf');
const SQL = require('better-sqlite3');
const { app, dialog, clipboard } = require('electron');
const { redactAll } = require('../js/modules/privacy');
const { remove: removeUserConfig } = require('./user_config');

const { map, isString, fromPairs, forEach, last, isEmpty, isObject, isNumber } = require('lodash');

/* eslint-disable camelcase */

module.exports = {
  initialize,
  close,
  removeDB,
  setSQLPassword,

  getPasswordHash,
  savePasswordHash,
  removePasswordHash,

  getIdentityKeyById,

  createOrUpdateItem,
  getItemById,
  getAllItems,
  removeItemById,

  getSwarmNodesForPubkey,
  updateSwarmNodesForPubkey,
  getGuardNodes,
  updateGuardNodes,

  getConversationCount,
  saveConversation,
  getConversationById,
  updateConversation,
  removeConversation,
  getAllConversations,
  getAllOpenGroupV1Conversations,
  getAllOpenGroupV2Conversations,
  getPubkeysInPublicConversation,
  getAllGroupsInvolvingId,
  removeAllConversations,

  searchConversations,
  searchMessages,
  searchMessagesInConversation,

  getMessageCount,
  saveMessage,
  cleanSeenMessages,
  cleanLastHashes,
  saveSeenMessageHashes,
  saveSeenMessageHash,
  updateLastHash,
  saveMessages,
  removeMessage,
  getUnreadByConversation,
  getUnreadCountByConversation,
  getMessageBySenderAndSentAt,
  getMessageBySenderAndServerTimestamp,
  getMessageBySenderAndTimestamp,
  getMessageIdsFromServerIds,
  getMessageById,
  getMessagesBySentAt,
  getSeenMessagesByHashList,
  getLastHashBySnode,
  getExpiredMessages,
  getOutgoingWithoutExpiresAt,
  getNextExpiringMessage,
  getMessagesByConversation,
  getFirstUnreadMessageIdInConversation,
  hasConversationOutgoingMessage,
  trimMessages,
  fillWithTestData,

  getUnprocessedCount,
  getAllUnprocessed,
  saveUnprocessed,
  updateUnprocessedAttempts,
  updateUnprocessedWithData,
  getUnprocessedById,
  removeUnprocessed,
  removeAllUnprocessed,

  getNextAttachmentDownloadJobs,
  saveAttachmentDownloadJob,
  setAttachmentDownloadJobPending,
  resetAttachmentDownloadPending,
  removeAttachmentDownloadJob,
  removeAllAttachmentDownloadJobs,

  removeAll,

  getMessagesWithVisualMediaAttachments,
  getMessagesWithFileAttachments,

  removeKnownAttachments,

  getAllEncryptionKeyPairsForGroup,
  getLatestClosedGroupEncryptionKeyPair,
  addClosedGroupEncryptionKeyPair,
  removeAllClosedGroupEncryptionKeyPairs,

  // open group v2
  getV2OpenGroupRoom,
  saveV2OpenGroupRoom,
  getAllV2OpenGroupRooms,
  getV2OpenGroupRoomByRoomId,
  removeV2OpenGroupRoom,
  removeOneOpenGroupV1Message,
};

const CONVERSATIONS_TABLE = 'conversations';
const MESSAGES_TABLE = 'messages';
const MESSAGES_FTS_TABLE = 'messages_fts';
const NODES_FOR_PUBKEY_TABLE = 'nodesForPubkey';
const OPEN_GROUP_ROOMS_V2_TABLE = 'openGroupRoomsV2';
const IDENTITY_KEYS_TABLE = 'identityKeys';
const GUARD_NODE_TABLE = 'guardNodes';
const ITEMS_TABLE = 'items';
const ATTACHMENT_DOWNLOADS_TABLE = 'attachment_downloads';
const CLOSED_GROUP_V2_KEY_PAIRS_TABLE = 'encryptionKeyPairsForClosedGroupV2';

const MAX_PUBKEYS_MEMBERS = 300;

function objectToJSON(data) {
  return JSON.stringify(data);
}
function jsonToObject(json) {
  return JSON.parse(json);
}

function getSQLiteVersion(db) {
  const { sqlite_version } = db.prepare('select sqlite_version() as sqlite_version').get();
  return sqlite_version;
}

function getSchemaVersion(db) {
  return db.pragma('schema_version', { simple: true });
}

function getSQLCipherVersion(db) {
  return db.pragma('cipher_version', { simple: true });
}

function getSQLCipherIntegrityCheck(db) {
  const rows = db.pragma('cipher_integrity_check');
  if (rows.length === 0) {
    return undefined;
  }
  return rows.map(row => row.cipher_integrity_check);
}

function keyDatabase(db, key) {
  // https://www.zetetic.net/sqlcipher/sqlcipher-api/#key
  // If the password isn't hex then we need to derive a key from it

  const deriveKey = HEX_KEY.test(key);

  const value = deriveKey ? `'${key}'` : `"x'${key}'"`;

  const pragramToRun = `key = ${value}`;

  db.pragma(pragramToRun);
}

function switchToWAL(db) {
  // https://sqlite.org/wal.html
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
}

function getSQLIntegrityCheck(db) {
  const checkResult = db.pragma('quick_check', { simple: true });
  if (checkResult !== 'ok') {
    return checkResult;
  }

  return undefined;
}

const HEX_KEY = /[^0-9A-Fa-f]/;

function migrateSchemaVersion(db) {
  const userVersion = getUserVersion(db);
  if (userVersion > 0) {
    return;
  }
  const schemaVersion = getSchemaVersion(db);

  const newUserVersion = schemaVersion > 18 ? 16 : schemaVersion;
  console.log(
    'migrateSchemaVersion: Migrating from schema_version ' +
      `${schemaVersion} to user_version ${newUserVersion}`
  );

  setUserVersion(db, newUserVersion);
}

function getUserVersion(db) {
  try {
    return db.pragma('user_version', { simple: true });
  } catch (e) {
    console.warn('getUserVersion error', e);
    return 0;
  }
}

function setUserVersion(db, version) {
  if (!isNumber(version)) {
    throw new Error(`setUserVersion: version ${version} is not a number`);
  }

  db.pragma(`user_version = ${version}`);
}

function openAndMigrateDatabase(filePath, key) {
  let db;

  // First, we try to open the database without any cipher changes
  try {
    db = new SQL(filePath, { verbose: null });

    keyDatabase(db, key);
    switchToWAL(db);
    migrateSchemaVersion(db);
    db.pragma('secure_delete = ON');

    return db;
  } catch (error) {
    if (db) {
      db.close();
    }
    console.log('migrateDatabase: Migration without cipher change failed', error);
  }

  // If that fails, we try to open the database with 3.x compatibility to extract the
  //   user_version (previously stored in schema_version, blown away by cipher_migrate).

  let db1;
  try {
    db1 = new SQL(filePath, { verbose: null });
    keyDatabase(db1, key);

    // https://www.zetetic.net/blog/2018/11/30/sqlcipher-400-release/#compatability-sqlcipher-4-0-0
    db1.pragma('cipher_compatibility = 3');
    migrateSchemaVersion(db1);
    db1.close();
  } catch (error) {
    if (db1) {
      db1.close();
    }
    console.log('migrateDatabase: migrateSchemaVersion failed', error);
    return null;
  }
  // After migrating user_version -> schema_version, we reopen database, because we can't
  //   migrate to the latest ciphers after we've modified the defaults.
  let db2;
  try {
    db2 = new SQL(filePath, { verbose: null });
    keyDatabase(db2, key);

    db2.pragma('cipher_migrate');
    switchToWAL(db2);

    // Because foreign key support is not enabled by default!
    db2.pragma('foreign_keys = OFF');

    return db2;
  } catch (error) {
    if (db2) {
      db2.close();
    }
    console.log('migrateDatabase: switchToWAL failed');
    return null;
  }
}

function openAndSetUpSQLCipher(filePath, { key }) {
  return openAndMigrateDatabase(filePath, key);
}

function setSQLPassword(password) {
  if (!globalInstance) {
    throw new Error('setSQLPassword: db is not initialized');
  }

  // If the password isn't hex then we need to derive a key from it
  const deriveKey = HEX_KEY.test(password);
  const value = deriveKey ? `'${password}'` : `"x'${password}'"`;
  globalInstance.pragma(`rekey = ${value}`);
}

function vacuumDatabase(db) {
  if (!db) {
    throw new Error('vacuum: db is not initialized');
  }
  console.time('vaccumming db');
  console.warn('Vacuuming DB. This might take a while.');
  db.exec('VACUUM;');
  console.warn('Vacuuming DB Finished');
  console.timeEnd('vaccumming db');
}

function updateToSchemaVersion1(currentVersion, db) {
  if (currentVersion >= 1) {
    return;
  }

  console.log('updateToSchemaVersion1: starting...');

  db.transaction(() => {
    db.exec(
      `CREATE TABLE ${MESSAGES_TABLE}(
      id STRING PRIMARY KEY ASC,
      json TEXT,

      unread INTEGER,
      expires_at INTEGER,
      sent BOOLEAN,
      sent_at INTEGER,
      schemaVersion INTEGER,
      conversationId STRING,
      received_at INTEGER,
      source STRING,
      sourceDevice STRING,
      hasAttachments INTEGER,
      hasFileAttachments INTEGER,
      hasVisualMediaAttachments INTEGER
    );

    CREATE INDEX messages_unread ON ${MESSAGES_TABLE} (
      unread
    );

    CREATE INDEX messages_expires_at ON ${MESSAGES_TABLE} (
      expires_at
    );

    CREATE INDEX messages_receipt ON ${MESSAGES_TABLE} (
      sent_at
    );

    CREATE INDEX messages_schemaVersion ON ${MESSAGES_TABLE} (
      schemaVersion
    );

    CREATE INDEX messages_conversation ON ${MESSAGES_TABLE} (
      conversationId,
      received_at
    );

    CREATE INDEX messages_duplicate_check ON ${MESSAGES_TABLE} (
      source,
      sourceDevice,
      sent_at
    );

    CREATE INDEX messages_hasAttachments ON ${MESSAGES_TABLE} (
      conversationId,
      hasAttachments,
      received_at
    );

    CREATE INDEX messages_hasFileAttachments ON ${MESSAGES_TABLE} (
      conversationId,
      hasFileAttachments,
      received_at
    );

    CREATE INDEX messages_hasVisualMediaAttachments ON ${MESSAGES_TABLE} (
      conversationId,
      hasVisualMediaAttachments,
      received_at
    );

    CREATE TABLE unprocessed(
      id STRING,
      timestamp INTEGER,
      json TEXT
    );

    CREATE INDEX unprocessed_id ON unprocessed (
      id
    );

    CREATE INDEX unprocessed_timestamp ON unprocessed (
      timestamp
    );


    `
    );
    db.pragma('user_version = 1');
  })();

  console.log('updateToSchemaVersion1: success!');
}

function updateToSchemaVersion2(currentVersion, db) {
  if (currentVersion >= 2) {
    return;
  }

  console.log('updateToSchemaVersion2: starting...');

  db.transaction(() => {
    db.exec(`ALTER TABLE ${MESSAGES_TABLE}
     ADD COLUMN expireTimer INTEGER;

     ALTER TABLE ${MESSAGES_TABLE}
     ADD COLUMN expirationStartTimestamp INTEGER;

     ALTER TABLE ${MESSAGES_TABLE}
     ADD COLUMN type STRING;

     CREATE INDEX messages_expiring ON ${MESSAGES_TABLE} (
      expireTimer,
      expirationStartTimestamp,
      expires_at
    );

    UPDATE ${MESSAGES_TABLE} SET
      expirationStartTimestamp = json_extract(json, '$.expirationStartTimestamp'),
      expireTimer = json_extract(json, '$.expireTimer'),
      type = json_extract(json, '$.type');


     `);
    db.pragma('user_version = 2');
  })();

  console.log('updateToSchemaVersion2: success!');
}

function updateToSchemaVersion3(currentVersion, db) {
  if (currentVersion >= 3) {
    return;
  }

  console.log('updateToSchemaVersion3: starting...');

  db.transaction(() => {
    db.exec(`
    DROP INDEX messages_expiring;
    DROP INDEX messages_unread;

    CREATE INDEX messages_without_timer ON ${MESSAGES_TABLE} (
      expireTimer,
      expires_at,
      type
    ) WHERE expires_at IS NULL AND expireTimer IS NOT NULL;

    CREATE INDEX messages_unread ON ${MESSAGES_TABLE} (
      conversationId,
      unread
    ) WHERE unread IS NOT NULL;

    ANALYZE;

    `);
    db.pragma('user_version = 3');
  })();

  console.log('updateToSchemaVersion3: success!');
}

function updateToSchemaVersion4(currentVersion, db) {
  if (currentVersion >= 4) {
    return;
  }

  console.log('updateToSchemaVersion4: starting...');

  db.transaction(() => {
    db.exec(`

    CREATE TABLE ${CONVERSATIONS_TABLE}(
      id STRING PRIMARY KEY ASC,
      json TEXT,

      active_at INTEGER,
      type STRING,
      members TEXT,
      name TEXT,
      profileName TEXT
    );

    CREATE INDEX conversations_active ON ${CONVERSATIONS_TABLE} (
      active_at
    ) WHERE active_at IS NOT NULL;
    CREATE INDEX conversations_type ON ${CONVERSATIONS_TABLE} (
      type
    ) WHERE type IS NOT NULL;

    `);

    db.pragma('user_version = 4');
  })();

  console.log('updateToSchemaVersion4: success!');
}

function updateToSchemaVersion6(currentVersion, db) {
  if (currentVersion >= 6) {
    return;
  }
  console.log('updateToSchemaVersion6: starting...');
  db.transaction(() => {
    db.exec(`
    CREATE TABLE lastHashes(
      snode TEXT PRIMARY KEY,
      hash TEXT,
      expiresAt INTEGER
    );

    CREATE TABLE seenMessages(
      hash TEXT PRIMARY KEY,
      expiresAt INTEGER
    );


    CREATE TABLE sessions(
      id STRING PRIMARY KEY ASC,
      number STRING,
      json TEXT
    );

    CREATE INDEX sessions_number ON sessions (
      number
    ) WHERE number IS NOT NULL;

    CREATE TABLE groups(
      id STRING PRIMARY KEY ASC,
      json TEXT
    );


    CREATE TABLE ${IDENTITY_KEYS_TABLE}(
      id STRING PRIMARY KEY ASC,
      json TEXT
    );

    CREATE TABLE ${ITEMS_TABLE}(
      id STRING PRIMARY KEY ASC,
      json TEXT
    );


    CREATE TABLE preKeys(
      id INTEGER PRIMARY KEY ASC,
      recipient STRING,
      json TEXT
    );


    CREATE TABLE signedPreKeys(
      id INTEGER PRIMARY KEY ASC,
      json TEXT
    );

    CREATE TABLE contactPreKeys(
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      identityKeyString VARCHAR(255),
      keyId INTEGER,
      json TEXT
    );

    CREATE UNIQUE INDEX contact_prekey_identity_key_string_keyid ON contactPreKeys (
      identityKeyString,
      keyId
    );

    CREATE TABLE contactSignedPreKeys(
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      identityKeyString VARCHAR(255),
      keyId INTEGER,
      json TEXT
    );

    CREATE UNIQUE INDEX contact_signed_prekey_identity_key_string_keyid ON contactSignedPreKeys (
      identityKeyString,
      keyId
    );

    `);
    db.pragma('user_version = 6');
  })();

  console.log('updateToSchemaVersion6: success!');
}

function updateToSchemaVersion7(currentVersion, db) {
  if (currentVersion >= 7) {
    return;
  }
  console.log('updateToSchemaVersion7: starting...');

  db.transaction(() => {
    db.exec(`
      -- SQLite has been coercing our STRINGs into numbers, so we force it with TEXT
      -- We create a new table then copy the data into it, since we can't modify columns
      DROP INDEX sessions_number;
      ALTER TABLE sessions RENAME TO sessions_old;

      CREATE TABLE sessions(
        id TEXT PRIMARY KEY,
        number TEXT,
        json TEXT
      );
      CREATE INDEX sessions_number ON sessions (
        number
      ) WHERE number IS NOT NULL;
      INSERT INTO sessions(id, number, json)
    SELECT "+" || id, number, json FROM sessions_old;
      DROP TABLE sessions_old;
    `);

    db.pragma('user_version = 7');
  })();

  console.log('updateToSchemaVersion7: success!');
}

function updateToSchemaVersion8(currentVersion, db) {
  if (currentVersion >= 8) {
    return;
  }
  console.log('updateToSchemaVersion8: starting...');

  db.transaction(() => {
    db.exec(`
    -- First, we pull a new body field out of the message table's json blob
    ALTER TABLE ${MESSAGES_TABLE}
      ADD COLUMN body TEXT;
    UPDATE ${MESSAGES_TABLE} SET body = json_extract(json, '$.body');

    -- Then we create our full-text search table and populate it
    CREATE VIRTUAL TABLE ${MESSAGES_FTS_TABLE}
      USING fts5(id UNINDEXED, body);

    INSERT INTO ${MESSAGES_FTS_TABLE}(id, body)
      SELECT id, body FROM ${MESSAGES_TABLE};

    -- Then we set up triggers to keep the full-text search table up to date
    CREATE TRIGGER messages_on_insert AFTER INSERT ON ${MESSAGES_TABLE} BEGIN
      INSERT INTO ${MESSAGES_FTS_TABLE} (
        id,
        body
      ) VALUES (
        new.id,
        new.body
      );
    END;
    CREATE TRIGGER messages_on_delete AFTER DELETE ON ${MESSAGES_TABLE} BEGIN
      DELETE FROM ${MESSAGES_FTS_TABLE} WHERE id = old.id;
    END;
    CREATE TRIGGER messages_on_update AFTER UPDATE ON ${MESSAGES_TABLE} BEGIN
      DELETE FROM ${MESSAGES_FTS_TABLE} WHERE id = old.id;
      INSERT INTO ${MESSAGES_FTS_TABLE}(
        id,
        body
      ) VALUES (
        new.id,
        new.body
      );
    END;

    `);
    // For formatting search results:
    //   https://sqlite.org/fts5.html#the_highlight_function
    //   https://sqlite.org/fts5.html#the_snippet_function
    db.pragma('user_version = 8');
  })();

  console.log('updateToSchemaVersion8: success!');
}

function updateToSchemaVersion9(currentVersion, db) {
  if (currentVersion >= 9) {
    return;
  }
  console.log('updateToSchemaVersion9: starting...');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE ${ATTACHMENT_DOWNLOADS_TABLE}(
        id STRING primary key,
        timestamp INTEGER,
        pending INTEGER,
        json TEXT
      );

      CREATE INDEX attachment_downloads_timestamp
        ON ${ATTACHMENT_DOWNLOADS_TABLE} (
          timestamp
      ) WHERE pending = 0;
      CREATE INDEX attachment_downloads_pending
        ON ${ATTACHMENT_DOWNLOADS_TABLE} (
          pending
      ) WHERE pending != 0;
    `);

    db.pragma('user_version = 9');
  })();

  console.log('updateToSchemaVersion9: success!');
}

function updateToSchemaVersion10(currentVersion, db) {
  if (currentVersion >= 10) {
    return;
  }
  console.log('updateToSchemaVersion10: starting...');

  db.transaction(() => {
    db.exec(`
      DROP INDEX unprocessed_id;
      DROP INDEX unprocessed_timestamp;
      ALTER TABLE unprocessed RENAME TO unprocessed_old;

      CREATE TABLE unprocessed(
        id STRING,
        timestamp INTEGER,
        version INTEGER,
        attempts INTEGER,
        envelope TEXT,
        decrypted TEXT,
        source TEXT,
        sourceDevice TEXT,
        serverTimestamp INTEGER
      );

      CREATE INDEX unprocessed_id ON unprocessed (
        id
      );
      CREATE INDEX unprocessed_timestamp ON unprocessed (
        timestamp
      );

      INSERT INTO unprocessed (
        id,
        timestamp,
        version,
        attempts,
        envelope,
        decrypted,
        source,
        sourceDevice,
        serverTimestamp
      ) SELECT
        id,
        timestamp,
        json_extract(json, '$.version'),
        json_extract(json, '$.attempts'),
        json_extract(json, '$.envelope'),
        json_extract(json, '$.decrypted'),
        json_extract(json, '$.source'),
        json_extract(json, '$.sourceDevice'),
        json_extract(json, '$.serverTimestamp')
      FROM unprocessed_old;

      DROP TABLE unprocessed_old;
    `);

    db.pragma('user_version = 10');
  })();
  console.log('updateToSchemaVersion10: success!');
}

function updateToSchemaVersion11(currentVersion, db) {
  if (currentVersion >= 11) {
    return;
  }
  console.log('updateToSchemaVersion11: starting...');
  db.transaction(() => {
    db.exec(`
      DROP TABLE groups;
    `);

    db.pragma('user_version = 11');
  })();
  console.log('updateToSchemaVersion11: success!');
}

const SCHEMA_VERSIONS = [
  updateToSchemaVersion1,
  updateToSchemaVersion2,
  updateToSchemaVersion3,
  updateToSchemaVersion4,
  () => null, // version 5 was dropped
  updateToSchemaVersion6,
  updateToSchemaVersion7,
  updateToSchemaVersion8,
  updateToSchemaVersion9,
  updateToSchemaVersion10,
  updateToSchemaVersion11,
];

function updateSchema(db) {
  const sqliteVersion = getSQLiteVersion(db);
  const sqlcipherVersion = getSQLCipherVersion(db);
  const userVersion = getUserVersion(db);
  const maxUserVersion = SCHEMA_VERSIONS.length;
  const schemaVersion = getSchemaVersion(db);

  console.log('updateSchema:');
  console.log(` Current user_version: ${userVersion}`);
  console.log(` Most recent db schema: ${maxUserVersion}`);
  console.log(` SQLite version: ${sqliteVersion}`);
  console.log(` SQLCipher version: ${sqlcipherVersion}`);
  console.log(` (deprecated) schema_version: ${schemaVersion}`);

  for (let index = 0, max = SCHEMA_VERSIONS.length; index < max; index += 1) {
    const runSchemaUpdate = SCHEMA_VERSIONS[index];
    runSchemaUpdate(schemaVersion, db);
  }
  updateLokiSchema(db);
}

const LOKI_SCHEMA_VERSIONS = [
  updateToLokiSchemaVersion1,
  updateToLokiSchemaVersion2,
  updateToLokiSchemaVersion3,
  updateToLokiSchemaVersion4,
  updateToLokiSchemaVersion5,
  updateToLokiSchemaVersion6,
  updateToLokiSchemaVersion7,
  updateToLokiSchemaVersion8,
  updateToLokiSchemaVersion9,
  updateToLokiSchemaVersion10,
  updateToLokiSchemaVersion11,
  updateToLokiSchemaVersion12,
  updateToLokiSchemaVersion13,
  updateToLokiSchemaVersion14,
  updateToLokiSchemaVersion15,
  updateToLokiSchemaVersion16,
  updateToLokiSchemaVersion17,
  updateToLokiSchemaVersion18,
  updateToLokiSchemaVersion19,
];

function updateToLokiSchemaVersion1(currentVersion, db) {
  const targetVersion = 1;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);
  db.transaction(() => {
    db.exec(`
    ALTER TABLE ${MESSAGES_TABLE}
    ADD COLUMN serverId INTEGER;

    CREATE TABLE servers(
      serverUrl STRING PRIMARY KEY ASC,
      token TEXT
    );
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();

  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion2(currentVersion, db) {
  const targetVersion = 2;

  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    CREATE TABLE pairingAuthorisations(
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      primaryDevicePubKey VARCHAR(255),
      secondaryDevicePubKey VARCHAR(255),
      isGranted BOOLEAN,
      json TEXT,
      UNIQUE(primaryDevicePubKey, secondaryDevicePubKey)
    );
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion3(currentVersion, db) {
  const targetVersion = 3;

  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    CREATE TABLE ${GUARD_NODE_TABLE}(
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      ed25519PubKey VARCHAR(64)
    );
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();

  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion4(currentVersion, db) {
  const targetVersion = 4;
  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    DROP TABLE lastHashes;
    CREATE TABLE lastHashes(
      id TEXT,
      snode TEXT,
      hash TEXT,
      expiresAt INTEGER,
      PRIMARY KEY (id, snode)
    );
    -- Add senderIdentity field to unprocessed needed for medium size groups
    ALTER TABLE unprocessed ADD senderIdentity TEXT;
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion5(currentVersion, db) {
  const targetVersion = 5;
  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    CREATE TABLE ${NODES_FOR_PUBKEY_TABLE} (
      pubkey TEXT PRIMARY KEY,
      json TEXT
    );

    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion6(currentVersion, db) {
  const targetVersion = 6;
  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    -- Remove RSS Feed conversations
    DELETE FROM ${CONVERSATIONS_TABLE} WHERE
    type = 'group' AND
    id LIKE 'rss://%';

    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion7(currentVersion, db) {
  const targetVersion = 7;
  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    -- Remove multi device data

    DELETE FROM pairingAuthorisations;
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion8(currentVersion, db) {
  const targetVersion = 8;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`

    ALTER TABLE ${MESSAGES_TABLE}
    ADD COLUMN serverTimestamp INTEGER;
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion9(currentVersion, db) {
  const targetVersion = 9;
  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT json FROM ${CONVERSATIONS_TABLE} WHERE
      type = 'group' AND
      id LIKE '__textsecure_group__!%';
    `
      )
      .all();

    const objs = map(rows, row => jsonToObject(row.json));

    const conversationIdRows = db
      .prepare(`SELECT id FROM ${CONVERSATIONS_TABLE} ORDER BY id ASC;`)
      .all();

    const allOldConversationIds = map(conversationIdRows, row => row.id);
    objs.forEach(o => {
      const oldId = o.id;
      const newId = oldId.replace('__textsecure_group__!', '');
      console.log(`migrating conversation, ${oldId} to ${newId}`);

      if (allOldConversationIds.includes(newId)) {
        console.log(
          'Found a duplicate conversation after prefix removing. We need to take care of it'
        );
        // We have another conversation with the same future name.
        // We decided to keep only the conversation with the higher number of messages
        const countMessagesOld = getMessagesCountByConversation(db, oldId, {
          limit: Number.MAX_VALUE,
        });
        const countMessagesNew = getMessagesCountByConversation(db, newId, {
          limit: Number.MAX_VALUE,
        });

        console.log(`countMessagesOld: ${countMessagesOld}, countMessagesNew: ${countMessagesNew}`);

        const deleteId = countMessagesOld > countMessagesNew ? newId : oldId;
        db.prepare(`DELETE FROM ${CONVERSATIONS_TABLE} WHERE id = $deleteId;`).run({ deleteId });
      }

      const morphedObject = {
        ...o,
        id: newId,
      };

      db.prepare(
        `UPDATE ${CONVERSATIONS_TABLE} SET
        id = $newId,
        json = $json
        WHERE id = $oldId;`
      ).run({
        newId,
        json: objectToJSON(morphedObject),
        oldId,
      });
    });

    writeLokiSchemaVersion(targetVersion, db);
  })();

  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion10(currentVersion, db) {
  const targetVersion = 10;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    CREATE TABLE ${CLOSED_GROUP_V2_KEY_PAIRS_TABLE} (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      groupPublicKey TEXT,
      timestamp NUMBER,
      json TEXT
    );

    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion11(currentVersion, db) {
  const targetVersion = 11;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    updateExistingClosedGroupV1ToClosedGroupV2(db);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion12(currentVersion, db) {
  const targetVersion = 12;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    CREATE TABLE ${OPEN_GROUP_ROOMS_V2_TABLE} (
      serverUrl TEXT NOT NULL,
      roomId TEXT NOT NULL,
      conversationId TEXT,
      json TEXT,
      PRIMARY KEY (serverUrl, roomId)
    );

    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion13(currentVersion, db) {
  const targetVersion = 13;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  // Clear any already deleted db entries.
  // secure_delete = ON will make sure next deleted entries are overwritten with 0 right away
  db.transaction(() => {
    db.pragma('secure_delete = ON');
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion14(currentVersion, db) {
  const targetVersion = 14;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
    DROP TABLE IF EXISTS servers;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS preKeys;
    DROP TABLE IF EXISTS contactPreKeys;
    DROP TABLE IF EXISTS contactSignedPreKeys;
    DROP TABLE IF EXISTS signedPreKeys;
    DROP TABLE IF EXISTS senderKeys;
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion15(currentVersion, db) {
  const targetVersion = 15;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
      DROP TABLE pairingAuthorisations;
      DROP TRIGGER messages_on_delete;
      DROP TRIGGER messages_on_update;
    `);

    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion16(currentVersion, db) {
  const targetVersion = 16;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
      ALTER TABLE ${MESSAGES_TABLE} ADD COLUMN serverHash TEXT;
      ALTER TABLE ${MESSAGES_TABLE} ADD COLUMN isDeleted BOOLEAN;

      CREATE INDEX messages_serverHash ON ${MESSAGES_TABLE} (
        serverHash
      ) WHERE serverHash IS NOT NULL;

      CREATE INDEX messages_isDeleted ON ${MESSAGES_TABLE} (
        isDeleted
      ) WHERE isDeleted IS NOT NULL;

      ALTER TABLE unprocessed ADD serverHash TEXT;
      CREATE INDEX messages_messageHash ON unprocessed (
        serverHash
      ) WHERE serverHash IS NOT NULL;
    `);

    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion17(currentVersion, db) {
  const targetVersion = 17;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
      UPDATE ${CONVERSATIONS_TABLE} SET
      json = json_set(json, '$.isApproved', 1)
    `);
    // remove the moderators field. As it was only used for opengroups a long time ago and whatever is there is probably unused
    db.exec(`
      UPDATE ${CONVERSATIONS_TABLE} SET
      json = json_remove(json, '$.moderators', '$.dataMessage', '$.accessKey', '$.profileSharing', '$.sessionRestoreSeen')
    `);
    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion18(currentVersion, db) {
  const targetVersion = 18;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  // Dropping all pre-existing schema relating to message searching.
  // Recreating the full text search and related triggers
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS messages_on_insert;
      DROP TRIGGER IF EXISTS messages_on_delete;
      DROP TRIGGER IF EXISTS messages_on_update;
      DROP TABLE IF EXISTS ${MESSAGES_FTS_TABLE};
    `);

    writeLokiSchemaVersion(targetVersion, db);
  })();

  db.transaction(() => {
    db.exec(`
    -- Then we create our full-text search table and populate it
    CREATE VIRTUAL TABLE ${MESSAGES_FTS_TABLE}
      USING fts5(id UNINDEXED, body);
    INSERT INTO ${MESSAGES_FTS_TABLE}(id, body)
      SELECT id, body FROM ${MESSAGES_TABLE};
    -- Then we set up triggers to keep the full-text search table up to date
    CREATE TRIGGER messages_on_insert AFTER INSERT ON ${MESSAGES_TABLE} BEGIN
      INSERT INTO ${MESSAGES_FTS_TABLE} (
        id,
        body
      ) VALUES (
        new.id,
        new.body
      );
    END;
    CREATE TRIGGER messages_on_delete AFTER DELETE ON ${MESSAGES_TABLE} BEGIN
      DELETE FROM ${MESSAGES_FTS_TABLE} WHERE id = old.id;
    END;
    CREATE TRIGGER messages_on_update AFTER UPDATE ON ${MESSAGES_TABLE} BEGIN
      DELETE FROM ${MESSAGES_FTS_TABLE} WHERE id = old.id;
      INSERT INTO ${MESSAGES_FTS_TABLE}(
        id,
        body
      ) VALUES (
        new.id,
        new.body
      );
    END;
    `);

    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion19(currentVersion, db) {
  const targetVersion = 19;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);

  db.transaction(() => {
    db.exec(`
      DROP INDEX messages_schemaVersion;
      ALTER TABLE ${MESSAGES_TABLE} DROP COLUMN schemaVersion;
    `);
    // this is way to slow for now...
    // db.exec(`
    //   UPDATE ${MESSAGES_TABLE} SET
    //   json = json_remove(json, '$.schemaVersion')
    // `);
    writeLokiSchemaVersion(targetVersion, db);
  })();

  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion20(currentVersion, db) {
  const targetVersion = 20;
  if (currentVersion >= targetVersion) {
    return;
  }
  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);
  db.transaction(() => {
    db.exec(`
        UPDATE ${CONVERSATIONS_TABLE} SET
        json = json_set(json, '$.didApproveMe', 1, '$.isApproved', 1)
        WHERE type = 'private';
      `);

    // all closed group admins
    const closedGroupRows = getAllClosedGroupConversations(db, false) || [];

    const adminIds = closedGroupRows.map(json => {
      return jsonToObject(json).groupAdmins;
    });
    forEach(adminIds, id => {
      db.exec(
        `
        UPDATE ${CONVERSATIONS_TABLE} SET
        json = json_set(json, '$.didApproveMe', 1, '$.isApproved', 1)
        WHERE type = id 
        values ($id);
      `
      ).run({
        id,
      });
    });

    writeLokiSchemaVersion(targetVersion, db);
  })();

  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function updateToLokiSchemaVersion21(currentVersion, db) {
  const targetVersion = 21;
  if (currentVersion >= targetVersion) {
    return;
  }

  console.log(`updateToLokiSchemaVersion${targetVersion}: starting...`);
  db.transaction(() => {
    // looking for all private conversations, with a nickname set
    const rowsToUpdate = db
      .prepare(
        `SELECT * FROM ${CONVERSATIONS_TABLE} WHERE type = 'private' AND (name IS NULL or name = '') AND json_extract(json, '$.nickname') <> '';`
      )
      .all();
    (rowsToUpdate || []).forEach(r => {
      const obj = jsonToObject(r.json);

      // obj.profile.displayName is the display as this user set it.
      if (
        obj &&
        obj.nickname &&
        obj.nickname.length &&
        obj.profile &&
        obj.profile.displayName &&
        obj.profile.displayName.length
      ) {
        // this one has a nickname set, but name is unset, set it to the displayName in the lokiProfile if it's exisitng
        obj.name = obj.profile.displayName;
        updateConversation(obj, db);
      }
    });

    writeLokiSchemaVersion(targetVersion, db);
  })();
  console.log(`updateToLokiSchemaVersion${targetVersion}: success!`);
}

function writeLokiSchemaVersion(newVersion, db) {
  db.prepare(
    `INSERT INTO loki_schema(
      version
    ) values (
      $newVersion
    )`
  ).run({ newVersion });
}

function updateLokiSchema(db) {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name='loki_schema';`)
    .get();

  if (!result) {
    createLokiSchemaTable(db);
  }
  const lokiSchemaVersion = getLokiSchemaVersion(db);
  console.log(
    'updateLokiSchema:',
    `Current loki schema version: ${lokiSchemaVersion};`,
    `Most recent schema version: ${LOKI_SCHEMA_VERSIONS.length};`
  );
  for (let index = 0, max = LOKI_SCHEMA_VERSIONS.length; index < max; index += 1) {
    const runSchemaUpdate = LOKI_SCHEMA_VERSIONS[index];
    runSchemaUpdate(lokiSchemaVersion, db);
  }
}

function getLokiSchemaVersion(db) {
  const result = db
    .prepare(
      `
    SELECT MAX(version) as version FROM loki_schema;
    `
    )
    .get();
  if (!result || !result.version) {
    return 0;
  }
  return result.version;
}

function createLokiSchemaTable(db) {
  db.transaction(() => {
    db.exec(`
    CREATE TABLE loki_schema(
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      version INTEGER
    );
    INSERT INTO loki_schema (
      version
    ) values (
      0
    );
    `);
  })();
}
let globalInstance;

let databaseFilePath;

function _initializePaths(configDir) {
  const dbDir = path.join(configDir, 'sql');
  fs.mkdirSync(dbDir, { recursive: true });
  databaseFilePath = path.join(dbDir, 'db.sqlite');
}

function initialize({ configDir, key, messages, passwordAttempt }) {
  if (globalInstance) {
    throw new Error('Cannot initialize more than once!');
  }

  if (!isString(configDir)) {
    throw new Error('initialize: configDir is required!');
  }
  if (!isString(key)) {
    throw new Error('initialize: key is required!');
  }
  if (!isObject(messages)) {
    throw new Error('initialize: message is required!');
  }

  _initializePaths(configDir);

  let db;
  try {
    db = openAndSetUpSQLCipher(databaseFilePath, { key });
    updateSchema(db);

    // test database

    const cipherIntegrityResult = getSQLCipherIntegrityCheck(db);
    if (cipherIntegrityResult) {
      console.log('Database cipher integrity check failed:', cipherIntegrityResult);
      throw new Error(`Cipher integrity check failed: ${cipherIntegrityResult}`);
    }
    const integrityResult = getSQLIntegrityCheck(db);
    if (integrityResult) {
      console.log('Database integrity check failed:', integrityResult);
      throw new Error(`Integrity check failed: ${integrityResult}`);
    }

    // At this point we can allow general access to the database
    globalInstance = db;

    // Clear any already deleted db entries on each app start.
    vacuumDatabase(db);
    const msgCount = getMessageCount();
    const convoCount = getConversationCount();
    console.info('total message count: ', msgCount);
    console.info('total conversation count: ', convoCount);
  } catch (error) {
    if (passwordAttempt) {
      throw error;
    }
    console.log('Database startup error:', error.stack);
    const buttonIndex = dialog.showMessageBox({
      buttons: [messages.copyErrorAndQuit, messages.clearAllData],
      defaultId: 0,
      detail: redactAll(error.stack),
      message: messages.databaseError,
      noLink: true,
      type: 'error',
    });

    if (buttonIndex === 0) {
      clipboard.writeText(`Database startup error:\n\n${redactAll(error.stack)}`);
    } else {
      close();
      removeDB();
      removeUserConfig();
      app.relaunch();
    }

    app.exit(1);
    return false;
  }

  return true;
}

function close() {
  if (!globalInstance) {
    return;
  }
  const dbRef = globalInstance;
  globalInstance = null;
  // SQLLite documentation suggests that we run `PRAGMA optimize` right before
  // closing the database connection.
  dbRef.pragma('optimize');
  dbRef.close();
}

function removeDB(configDir = null) {
  if (globalInstance) {
    throw new Error('removeDB: Cannot erase database when it is open!');
  }

  if (globalInstance) {
    throw new Error('removeDB: Cannot erase database when it is open!');
  }

  if (!databaseFilePath && configDir) {
    _initializePaths(configDir);
  }

  rimraf.sync(databaseFilePath);
  rimraf.sync(`${databaseFilePath}-shm`);
  rimraf.sync(`${databaseFilePath}-wal`);
}

// Password hash
const PASS_HASH_ID = 'passHash';
function getPasswordHash() {
  const item = getItemById(PASS_HASH_ID);
  return item && item.value;
}
function savePasswordHash(hash) {
  if (isEmpty(hash)) {
    return removePasswordHash();
  }

  const data = { id: PASS_HASH_ID, value: hash };
  return createOrUpdateItem(data);
}
function removePasswordHash() {
  return removeItemById(PASS_HASH_ID);
}

function getIdentityKeyById(id, instance) {
  return getById(IDENTITY_KEYS_TABLE, id, instance);
}

function getGuardNodes() {
  const nodes = globalInstance.prepare(`SELECT ed25519PubKey FROM ${GUARD_NODE_TABLE};`).all();

  if (!nodes) {
    return null;
  }

  return nodes;
}

function updateGuardNodes(nodes) {
  globalInstance.transaction(() => {
    globalInstance.exec(`DELETE FROM ${GUARD_NODE_TABLE}`);
    nodes.map(edkey =>
      globalInstance
        .prepare(
          `INSERT INTO ${GUARD_NODE_TABLE} (
        ed25519PubKey
      ) values ($ed25519PubKey)`
        )
        .run({
          ed25519PubKey: edkey,
        })
    );
  })();
}

function createOrUpdateItem(data, instance) {
  return createOrUpdate(ITEMS_TABLE, data, instance);
}
function getItemById(id) {
  return getById(ITEMS_TABLE, id);
}
function getAllItems() {
  const rows = globalInstance.prepare(`SELECT json FROM ${ITEMS_TABLE} ORDER BY id ASC;`).all();
  return map(rows, row => jsonToObject(row.json));
}
function removeItemById(id) {
  return removeById(ITEMS_TABLE, id);
}

function createOrUpdate(table, data, instance) {
  const { id } = data;
  if (!id) {
    throw new Error('createOrUpdate: Provided data did not have a truthy id');
  }

  (globalInstance || instance)
    .prepare(
      `INSERT OR REPLACE INTO ${table} (
      id,
      json
    ) values (
      $id,
      $json
    )`
    )
    .run({
      id,
      json: objectToJSON(data),
    });
}

function getById(table, id, instance) {
  const row = (globalInstance || instance).prepare(`SELECT * FROM ${table} WHERE id = $id;`).get({
    id,
  });

  if (!row) {
    return null;
  }

  return jsonToObject(row.json);
}

function removeById(table, id) {
  if (!Array.isArray(id)) {
    globalInstance.prepare(`DELETE FROM ${table} WHERE id = $id;`).run({ id });
    return;
  }

  if (!id.length) {
    throw new Error('removeById: No ids to delete!');
  }

  // Our node interface doesn't seem to allow you to replace one single ? with an array
  globalInstance
    .prepare(`DELETE FROM ${table} WHERE id IN ( ${id.map(() => '?').join(', ')} );`)
    .run({ id });
}

// Conversations

function getSwarmNodesForPubkey(pubkey) {
  const row = globalInstance
    .prepare(`SELECT * FROM ${NODES_FOR_PUBKEY_TABLE} WHERE pubkey = $pubkey;`)
    .get({
      pubkey,
    });

  if (!row) {
    return [];
  }

  return jsonToObject(row.json);
}

function updateSwarmNodesForPubkey(pubkey, snodeEdKeys) {
  globalInstance
    .prepare(
      `INSERT OR REPLACE INTO ${NODES_FOR_PUBKEY_TABLE} (
        pubkey,
        json
        ) values (
          $pubkey,
          $json
          );`
    )
    .run({
      pubkey,
      json: objectToJSON(snodeEdKeys),
    });
}

function getConversationCount() {
  const row = globalInstance.prepare(`SELECT count(*) from ${CONVERSATIONS_TABLE};`).get();
  if (!row) {
    throw new Error(`getConversationCount: Unable to get count of ${CONVERSATIONS_TABLE}`);
  }

  return row['count(*)'];
}

function saveConversation(data) {
  const { id, active_at, type, members, name, profileName } = data;

  globalInstance
    .prepare(
      `INSERT INTO ${CONVERSATIONS_TABLE} (
    id,
    json,

    active_at,
    type,
    members,
    name,
    profileName
  ) values (
    $id,
    $json,

    $active_at,
    $type,
    $members,
    $name,
    $profileName
  );`
    )
    .run({
      id,
      json: objectToJSON(data),

      active_at,
      type,
      members: members ? members.join(' ') : null,
      name,
      profileName,
    });
}

function updateConversation(data) {
  const {
    id,
    // eslint-disable-next-line camelcase
    active_at,
    type,
    members,
    name,
    profileName,
  } = data;

  globalInstance
    .prepare(
      `UPDATE ${CONVERSATIONS_TABLE} SET
    json = $json,

    active_at = $active_at,
    type = $type,
    members = $members,
    name = $name,
    profileName = $profileName
    WHERE id = $id;`
    )
    .run({
      id,
      json: objectToJSON(data),

      active_at,
      type,
      members: members ? members.join(' ') : null,
      name,
      profileName,
    });
}

function removeConversation(id) {
  if (!Array.isArray(id)) {
    globalInstance.prepare(`DELETE FROM ${CONVERSATIONS_TABLE} WHERE id = $id;`).run({
      id,
    });
    return;
  }

  if (!id.length) {
    throw new Error('removeConversation: No ids to delete!');
  }

  // Our node interface doesn't seem to allow you to replace one single ? with an array
  globalInstance
    .prepare(`DELETE FROM ${CONVERSATIONS_TABLE} WHERE id IN ( ${id.map(() => '?').join(', ')} );`)
    .run(id);
}

function getConversationById(id) {
  const row = globalInstance.prepare(`SELECT * FROM ${CONVERSATIONS_TABLE} WHERE id = $id;`).get({
    id,
  });

  if (!row) {
    return null;
  }

  return jsonToObject(row.json);
}

function getAllConversations() {
  const rows = globalInstance
    .prepare(`SELECT json FROM ${CONVERSATIONS_TABLE} ORDER BY id ASC;`)
    .all();
  return map(rows, row => jsonToObject(row.json));
}

function getAllOpenGroupV1Conversations() {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${CONVERSATIONS_TABLE} WHERE
      type = 'group' AND
      id LIKE 'publicChat:1@%'
     ORDER BY id ASC;`
    )
    .all();

  return map(rows, row => jsonToObject(row.json));
}

function getAllOpenGroupV2Conversations() {
  // first _ matches all opengroupv1,
  // second _ force a second char to be there, so it can only be opengroupv2 convos

  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${CONVERSATIONS_TABLE} WHERE
      type = 'group' AND
      id LIKE 'publicChat:__%@%'
     ORDER BY id ASC;`
    )
    .all();

  return map(rows, row => jsonToObject(row.json));
}

function getPubkeysInPublicConversation(conversationId) {
  const rows = globalInstance
    .prepare(
      `SELECT DISTINCT source FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId
     ORDER BY received_at DESC LIMIT ${MAX_PUBKEYS_MEMBERS};`
    )
    .all({
      conversationId,
    });

  return map(rows, row => row.source);
}

function getAllGroupsInvolvingId(id) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${CONVERSATIONS_TABLE} WHERE
      type = 'group' AND
      members LIKE $id
     ORDER BY id ASC;`
    )
    .all({
      id: `%${id}%`,
    });

  return map(rows, row => jsonToObject(row.json));
}

function searchConversations(query, { limit } = {}) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${CONVERSATIONS_TABLE} WHERE
      (
        id LIKE $id OR
        name LIKE $name OR
        profileName LIKE $profileName
      )
     ORDER BY id ASC
     LIMIT $limit`
    )
    .all({
      id: `%${query}%`,
      name: `%${query}%`,
      profileName: `%${query}%`,
      limit: limit || 50,
    });

  return map(rows, row => jsonToObject(row.json));
}

function searchMessages(query, { limit } = {}) {
  const rows = globalInstance
    .prepare(
      `SELECT
      messages.json,
      snippet(messages_fts, -1, '<<left>>', '<<right>>', '...', 15) as snippet
    FROM ${MESSAGES_FTS_TABLE}
    INNER JOIN ${MESSAGES_TABLE} on messages_fts.id = messages.id
    WHERE
      messages_fts match $query
    ORDER BY messages.received_at DESC
    LIMIT $limit;`
    )
    .all({
      query,
      limit: limit || 100,
    });

  return map(rows, row => ({
    ...jsonToObject(row.json),
    snippet: row.snippet,
  }));
}

function searchMessagesInConversation(query, conversationId, { limit } = {}) {
  const rows = globalInstance
    .prepare(
      `SELECT
      messages.json,
      snippet(messages_fts, -1, '<<left>>', '<<right>>', '...', 15) as snippet
    FROM messages_fts
    INNER JOIN ${MESSAGES_TABLE} on messages_fts.id = messages.id
    WHERE
      messages_fts match $query AND
      messages.conversationId = $conversationId
    ORDER BY messages.received_at DESC
    LIMIT $limit;`
    )
    .all({
      query,
      conversationId,
      limit: limit || 100,
    });

  return map(rows, row => ({
    ...jsonToObject(row.json),
    snippet: row.snippet,
  }));
}

function getMessageCount() {
  const row = globalInstance.prepare(`SELECT count(*) from ${MESSAGES_TABLE};`).get();

  if (!row) {
    throw new Error(`getMessageCount: Unable to get count of ${MESSAGES_TABLE}`);
  }
  return row['count(*)'];
}

function saveMessage(data) {
  const {
    body,
    conversationId,
    // eslint-disable-next-line camelcase
    expires_at,
    hasAttachments,
    hasFileAttachments,
    hasVisualMediaAttachments,
    id,
    serverId,
    serverTimestamp,
    // eslint-disable-next-line camelcase
    received_at,
    sent,
    // eslint-disable-next-line camelcase
    sent_at,
    source,
    sourceDevice,
    type,
    unread,
    expireTimer,
    expirationStartTimestamp,
  } = data;

  if (!id) {
    throw new Error('id is required');
  }

  if (!conversationId) {
    throw new Error('conversationId is required');
  }

  const payload = {
    id,
    json: objectToJSON(data),

    serverId,
    serverTimestamp,
    body,
    conversationId,
    expirationStartTimestamp,
    expires_at,
    expireTimer,
    hasAttachments,
    hasFileAttachments,
    hasVisualMediaAttachments,
    received_at,
    sent,
    sent_at,
    source,
    sourceDevice,
    type: type || '',
    unread,
  };

  globalInstance
    .prepare(
      `INSERT OR REPLACE INTO ${MESSAGES_TABLE} (
    id,
    json,
    serverId,
    serverTimestamp,
    body,
    conversationId,
    expirationStartTimestamp,
    expires_at,
    expireTimer,
    hasAttachments,
    hasFileAttachments,
    hasVisualMediaAttachments,
    received_at,
    sent,
    sent_at,
    source,
    sourceDevice,
    type,
    unread
  ) values (
    $id,
    $json,
    $serverId,
    $serverTimestamp,
    $body,
    $conversationId,
    $expirationStartTimestamp,
    $expires_at,
    $expireTimer,
    $hasAttachments,
    $hasFileAttachments,
    $hasVisualMediaAttachments,
    $received_at,
    $sent,
    $sent_at,
    $source,
    $sourceDevice,
    $type,
    $unread
  );`
    )
    .run(payload);

  return id;
}

function saveSeenMessageHashes(arrayOfHashes) {
  globalInstance.transaction(() => {
    map(arrayOfHashes, hashData => saveSeenMessageHash(hashData));
  })();
}

function updateLastHash(data) {
  const { convoId, snode, hash, expiresAt } = data;

  const id = convoId;

  globalInstance
    .prepare(
      `INSERT OR REPLACE INTO lastHashes (
      id,
      snode,
      hash,
      expiresAt
    ) values (
      $id,
      $snode,
      $hash,
      $expiresAt
    )`
    )
    .run({
      id,
      snode,
      hash,
      expiresAt,
    });
}

function saveSeenMessageHash(data) {
  const { expiresAt, hash } = data;
  try {
    globalInstance
      .prepare(
        `INSERT INTO seenMessages (
      expiresAt,
      hash
      ) values (
        $expiresAt,
        $hash
        );`
      )
      .run({
        expiresAt,
        hash,
      });
  } catch (e) {
    console.warn('saveSeenMessageHash failed:', e);
  }
}

function cleanLastHashes() {
  globalInstance.prepare('DELETE FROM lastHashes WHERE expiresAt <= $now;').run({
    now: Date.now(),
  });
}

function cleanSeenMessages() {
  globalInstance.prepare('DELETE FROM seenMessages WHERE expiresAt <= $now;').run({
    now: Date.now(),
  });
}

function saveMessages(arrayOfMessages) {
  globalInstance.transaction(() => {
    map(arrayOfMessages, message => saveMessage(message));
  })();
}

function removeMessage(id, instance) {
  if (!Array.isArray(id)) {
    (globalInstance || instance)
      .prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE id = $id;`)
      .run({ id });
    return;
  }

  if (!id.length) {
    throw new Error('removeMessages: No ids to delete!');
  }

  // Our node interface doesn't seem to allow you to replace one single ? with an array
  (globalInstance || instance)
    .prepare(`DELETE FROM ${MESSAGES_TABLE} WHERE id IN ( ${id.map(() => '?').join(', ')} );`)
    .run(id);
}

function getMessageIdsFromServerIds(serverIds, conversationId) {
  if (!Array.isArray(serverIds)) {
    return [];
  }

  // Sanitize the input as we're going to use it directly in the query
  const validIds = serverIds.map(id => Number(id)).filter(n => !Number.isNaN(n));

  /*
    Sqlite3 doesn't have a good way to have `IN` query with another query.
    See: https://github.com/mapbox/node-sqlite3/issues/762.

    So we have to use templating to insert the values.
  */
  const rows = globalInstance
    .prepare(
      `SELECT id FROM ${MESSAGES_TABLE} WHERE
    serverId IN (${validIds.join(',')}) AND
    conversationId = $conversationId;`
    )
    .all({
      conversationId,
    });
  return rows.map(row => row.id);
}

function getMessageById(id) {
  const row = globalInstance.prepare(`SELECT * FROM ${MESSAGES_TABLE} WHERE id = $id;`).get({
    id,
  });

  if (!row) {
    return null;
  }

  return jsonToObject(row.json);
}

function getMessageBySenderAndSentAt({ source, sentAt }) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      source = $source AND
      sent_at = $sent_at;`
    )
    .all({
      source,
      sent_at: sentAt,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getMessageBySenderAndTimestamp({ source, timestamp }) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      source = $source AND
      sent_at = $timestamp;`
    )
    .all({
      source,
      timestamp,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getMessageBySenderAndServerTimestamp({ source, serverTimestamp }) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      source = $source AND
      serverTimestamp = $serverTimestamp;`
    )
    .all({
      source,
      serverTimestamp,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getUnreadByConversation(conversationId) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      unread = $unread AND
      conversationId = $conversationId
     ORDER BY received_at DESC;`
    )
    .all({
      unread: 1,
      conversationId,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getUnreadCountByConversation(conversationId) {
  const row = globalInstance
    .prepare(
      `SELECT count(*) from ${MESSAGES_TABLE} WHERE
    unread = $unread AND
    conversationId = $conversationId
    ORDER BY received_at DESC;`
    )
    .get({
      unread: 1,
      conversationId,
    });

  if (!row) {
    throw new Error(
      `getUnreadCountByConversation: Unable to get unread count of ${conversationId}`
    );
  }

  return row['count(*)'];
}

// Note: Sorting here is necessary for getting the last message (with limit 1)
// be sure to update the sorting order to sort messages on redux too (sortMessages)
const orderByClause = 'ORDER BY COALESCE(serverTimestamp, sent_at, received_at) DESC';
const orderByClauseASC = 'ORDER BY COALESCE(serverTimestamp, sent_at, received_at) ASC';

function getMessagesByConversation(conversationId, { messageId = null } = {}) {
  const absLimit = 30;
  // If messageId is given it means we are opening the conversation to that specific messageId,
  // or that we just scrolled to it by a quote click and needs to load around it.
  // If messageId is null, it means we are just opening the convo to the last unread message, or at the bottom
  const firstUnread = getFirstUnreadMessageIdInConversation(conversationId);

  if (messageId || firstUnread) {
    const messageFound = getMessageById(messageId || firstUnread);

    if (messageFound && messageFound.conversationId === conversationId) {
      const rows = globalInstance
        .prepare(
          `WITH cte AS (
            SELECT id, conversationId, json, row_number() OVER (${orderByClause}) as row_number
              FROM ${MESSAGES_TABLE} WHERE conversationId = $conversationId
          ), current AS (
          SELECT row_number
            FROM cte
          WHERE id = $messageId

        )
        SELECT cte.*
          FROM cte, current
            WHERE ABS(cte.row_number - current.row_number) <= $limit
          ORDER BY cte.row_number;
          `
        )
        .all({
          conversationId,
          messageId: messageId || firstUnread,
          limit: absLimit,
        });

      return map(rows, row => jsonToObject(row.json));
    }
    console.info(
      `getMessagesByConversation: Could not find messageId ${messageId} in db with conversationId: ${conversationId}. Just fetching the convo as usual.`
    );
  }

  const limit = 2 * absLimit;

  const rows = globalInstance
    .prepare(
      `
    SELECT json FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId
      ${orderByClause}
    LIMIT $limit;
    `
    )
    .all({
      conversationId,
      received_at: receivedAt,
      limit,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getLastMessagesByConversation(conversationId, limit) {
  if (!isNumber(limit)) {
    throw new Error('limit must be a number');
  }

  const rows = globalInstance
    .prepare(
      `
    SELECT json FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId
      ${orderByClause}
    LIMIT $limit;
    `
    )
    .all({
      conversationId,
      limit,
    });
  return map(rows, row => jsonToObject(row.json));
}

/**
 * This is the oldest message so we cannot reuse getLastMessagesByConversation
 */
function getOldestMessageInConversation(conversationId) {
  const rows = globalInstance
    .prepare(
      `
    SELECT json FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId
      ${orderByClauseASC}
    LIMIT $limit;
    `
    )
    .all({
      conversationId,
      limit: 1,
    });
  return map(rows, row => jsonToObject(row.json));
}

function hasConversationOutgoingMessage(conversationId) {
  const row = globalInstance
    .prepare(
      `
    SELECT count(*)  FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId AND
      type IS 'outgoing'
    `
    )
    .get({
      conversationId,
    });
  if (!row) {
    throw new Error('hasConversationOutgoingMessage: Unable to get coun');
  }

  return Boolean(row['count(*)']);
}

function getFirstUnreadMessageIdInConversation(conversationId) {
  const rows = globalInstance
    .prepare(
      `
    SELECT id FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId AND
      unread = $unread
      ORDER BY serverTimestamp ASC, serverId ASC, sent_at ASC, received_at ASC
    LIMIT 1;
    `
    )
    .all({
      conversationId,
      unread: 1,
    });

  if (rows.length === 0) {
    return undefined;
  }
  return rows[0].id;
}

function getFirstUnreadMessageWithMention(conversationId, ourpubkey) {
  if (!ourpubkey || !ourpubkey.length) {
    throw new Error('getFirstUnreadMessageWithMention needs our pubkey but nothing was given');
  }
  const likeMatch = `%@${ourpubkey}%`;

  const rows = globalInstance
    .prepare(
      `
    SELECT id, json FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId AND
      unread = $unread AND
      body LIKE $likeMatch
      ORDER BY serverTimestamp ASC, serverId ASC, sent_at ASC, received_at ASC
    LIMIT 1;
    `
    )
    .all({
      conversationId,
      unread: 1,
      likeMatch,
    });

  if (rows.length === 0) {
    return undefined;
  }
  return rows[0].id;
}

/**
 * Deletes all but the 10,000 last received messages.
 */
function trimMessages(limit) {
  console.log(limit); // adding this for linting purposes.
  // METHOD 1 Start - Seems to take to long and freeze
  // const convoCount = globalInstance
  //   .prepare(
  //     `
  //       SELECT COUNT(*) FROM ${MESSAGES_TABLE}
  //       WHERE conversationId = $conversationId
  //     `
  //   )
  //   .all({
  //     conversationId,
  //   });
  // if (convoCount < limit) {
  //   console.log(`Skipping conversation: ${conversationId}`);
  //   return;
  // } else {
  //   console.count('convo surpassed limit');
  // }
  // globalInstance
  //   .prepare(
  //     `
  //     DELETE FROM ${MESSAGES_TABLE}
  //     WHERE conversationId = $conversationId
  //     AND id NOT IN (
  //       SELECT id FROM ${MESSAGES_TABLE}
  //       WHERE conversationId = $conversationId
  //       ORDER BY received_at DESC
  //       LIMIT $limit
  //     );
  //   `
  //   )
  //   .run({
  //     conversationId,
  //     limit,
  //   });
  // METHOD 1 END
  // METHOD 2 Start
  // const messages = globalInstance
  //   .prepare(
  //     `
  //       SELECT id, conversationId FROM ${MESSAGES_TABLE}
  //       CREATE VIRTUAL TABLE IF NOT EXISTS temp_deletion
  //       id STRING PRIMARY KEY ASC
  //     `
  //   )
  //   .all();
  // const idsToDelete = [];
  // const convoCountLookup = {};
  // for (let index = 0; index < messages.length; index + 1) {
  //   const { conversationId, id } = messages[index];
  //   console.log(`run ${index} - convoId: ${conversationId}, messageId: ${id}`);
  //   if (!convoCountLookup[conversationId]) {
  //     convoCountLookup[conversationId] = 1;
  //   } else {
  //     convoCountLookup[conversationId] + 1;
  //     if (convoCountLookup[conversationId] > limit) {
  //       idsToDelete.push(id);
  //     }
  //   }
  // }
  // // Ideally should be able to do WHERE id IN (x, y, z) with an array of IDs
  // // the array might need to be chunked as well for performance
  // const idSlice = [...idsToDelete].slice(0, 30);
  // idSlice.forEach(() => {
  //   globalInstance
  //     .prepare(
  //       `
  //         DELETE FROM ${MESSAGES_TABLE}
  //         WHERE id = $idSlice
  //       `
  //     )
  //     .run({
  //       idSlice,
  //     });
  // });
  // Method 2 End
  // Method 3 start - Audric's suggestion
  // const largeConvos = globalInstance
  //   .prepare(
  //     `
  //     SELECT conversationId, count(id) FROM ${MESSAGES_TABLE}
  //     GROUP BY conversationId
  //     HAVING COUNT(id) > 1000
  //     `
  //   )
  //   .all();
  // console.log({ largeConvos });
  // // finding 1000th msg timestamp
  // largeConvos.forEach(convo => {
  //   const convoId = convo.conversationId;
  //   console.log({ convoId });
  //   const lastMsg = globalInstance
  //     .prepare(
  //       `
  //         SELECT received_at, sent_at FROM ${MESSAGES_TABLE}
  //         WHERE conversationId = $convoId
  //         ORDER BY received_at DESC
  //         LIMIT 1
  //         OFFSET 999
  //     `
  //     )
  //     .all({
  //       convoId,
  //     });
  //   // use timestamp with lesserThan as conditional for deletion
  //   console.log({ lastMsg });
  //   const timestamp = lastMsg[0].received_at;
  //   if (timestamp) {
  //     console.log({ timestamp, convoId });
  //     globalInstance
  //       .prepare(
  //         `
  //           DELETE FROM ${MESSAGES_TABLE}
  //           WHERE conversationId = $convoId
  //           AND received_at < $timestamp
  //         `
  //       )
  //       .run({
  //         timestamp,
  //         convoId,
  //       });
  //   }
  // });
}

function getMessagesBySentAt(sentAt) {
  const rows = globalInstance
    .prepare(
      `SELECT * FROM ${MESSAGES_TABLE}
     WHERE sent_at = $sent_at
     ORDER BY received_at DESC;`
    )
    .all({
      sent_at: sentAt,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getLastHashBySnode(convoId, snode) {
  const row = globalInstance
    .prepare('SELECT * FROM lastHashes WHERE snode = $snode AND id = $id;')
    .get({
      snode,
      id: convoId,
    });

  if (!row) {
    return null;
  }

  return row.hash;
}

function getSeenMessagesByHashList(hashes) {
  const rows = globalInstance
    .prepare(`SELECT * FROM seenMessages WHERE hash IN ( ${hashes.map(() => '?').join(', ')} );`)
    .all(hashes);

  return map(rows, row => row.hash);
}

function getExpiredMessages() {
  const now = Date.now();

  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      expires_at IS NOT NULL AND
      expires_at <= $expires_at
     ORDER BY expires_at ASC;`
    )
    .all({
      expires_at: now,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getOutgoingWithoutExpiresAt() {
  const rows = globalInstance
    .prepare(
      `
    SELECT json FROM ${MESSAGES_TABLE}
    WHERE
      expireTimer > 0 AND
      expires_at IS NULL AND
      type IS 'outgoing'
    ORDER BY expires_at ASC;
  `
    )
    .all();

  return map(rows, row => jsonToObject(row.json));
}

function getNextExpiringMessage() {
  const rows = globalInstance
    .prepare(
      `
    SELECT json FROM ${MESSAGES_TABLE}
    WHERE expires_at > 0
    ORDER BY expires_at ASC
    LIMIT 1;
  `
    )
    .all();

  return map(rows, row => jsonToObject(row.json));
}

/* Unproccessed a received messages not yet processed */
function saveUnprocessed(data) {
  const { id, timestamp, version, attempts, envelope, senderIdentity, messageHash } = data;
  if (!id) {
    throw new Error(`saveUnprocessed: id was falsey: ${id}`);
  }

  globalInstance
    .prepare(
      `INSERT OR REPLACE INTO unprocessed (
      id,
      timestamp,
      version,
      attempts,
      envelope,
      senderIdentity,
      serverHash
    ) values (
      $id,
      $timestamp,
      $version,
      $attempts,
      $envelope,
      $senderIdentity,
      $messageHash
    );`
    )
    .run({
      id,
      timestamp,
      version,
      attempts,
      envelope,
      senderIdentity,
      messageHash,
    });

  return id;
}

function updateUnprocessedAttempts(id, attempts) {
  globalInstance.prepare('UPDATE unprocessed SET attempts = $attempts WHERE id = $id;').run({
    id,
    attempts,
  });
}
function updateUnprocessedWithData(id, data = {}) {
  const { source, sourceDevice, serverTimestamp, decrypted, senderIdentity } = data;

  globalInstance
    .prepare(
      `UPDATE unprocessed SET
      source = $source,
      sourceDevice = $sourceDevice,
      serverTimestamp = $serverTimestamp,
      decrypted = $decrypted,
      senderIdentity = $senderIdentity
    WHERE id = $id;`
    )
    .run({
      id,
      source,
      sourceDevice,
      serverTimestamp,
      decrypted,
      senderIdentity,
    });
}

function getUnprocessedById(id) {
  const row = globalInstance.prepare('SELECT * FROM unprocessed WHERE id = $id;').get({
    id,
  });

  return row;
}

function getUnprocessedCount() {
  const row = globalInstance.prepare('SELECT count(*) from unprocessed;').get();

  if (!row) {
    throw new Error('getMessageCount: Unable to get count of unprocessed');
  }

  return row['count(*)'];
}

function getAllUnprocessed() {
  const rows = globalInstance.prepare('SELECT * FROM unprocessed ORDER BY timestamp ASC;').all();

  return rows;
}

function removeUnprocessed(id) {
  if (!Array.isArray(id)) {
    globalInstance.prepare('DELETE FROM unprocessed WHERE id = $id;').run({ id });
    return;
  }

  if (!id.length) {
    throw new Error('removeUnprocessed: No ids to delete!');
  }

  // Our node interface doesn't seem to allow you to replace one single ? with an array
  globalInstance
    .prepare(`DELETE FROM unprocessed WHERE id IN ( ${id.map(() => '?').join(', ')} );`)
    .run(id);
}

function removeAllUnprocessed() {
  globalInstance.prepare('DELETE FROM unprocessed;').run();
}

function getNextAttachmentDownloadJobs(limit, options = {}) {
  const timestamp = options.timestamp || Date.now();

  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${ATTACHMENT_DOWNLOADS_TABLE}
    WHERE pending = 0 AND timestamp < $timestamp
    ORDER BY timestamp DESC
    LIMIT $limit;`
    )
    .all({
      limit,
      timestamp,
    });

  return map(rows, row => jsonToObject(row.json));
}

function saveAttachmentDownloadJob(job) {
  const { id, pending, timestamp } = job;
  if (!id) {
    throw new Error('saveAttachmentDownloadJob: Provided job did not have a truthy id');
  }

  globalInstance
    .prepare(
      `INSERT OR REPLACE INTO ${ATTACHMENT_DOWNLOADS_TABLE} (
      id,
      pending,
      timestamp,
      json
    ) values (
      $id,
      $pending,
      $timestamp,
      $json
    )`
    )
    .run({
      id,
      pending,
      timestamp,
      json: objectToJSON(job),
    });
}

function setAttachmentDownloadJobPending(id, pending) {
  globalInstance
    .prepare(`UPDATE ${ATTACHMENT_DOWNLOADS_TABLE} SET pending = $pending WHERE id = $id;`)
    .run({
      id,
      pending,
    });
}

function resetAttachmentDownloadPending() {
  globalInstance
    .prepare(`UPDATE ${ATTACHMENT_DOWNLOADS_TABLE} SET pending = 0 WHERE pending != 0;`)
    .run();
}
function removeAttachmentDownloadJob(id) {
  return removeById(ATTACHMENT_DOWNLOADS_TABLE, id);
}
function removeAllAttachmentDownloadJobs() {
  globalInstance.exec(`DELETE FROM ${ATTACHMENT_DOWNLOADS_TABLE};`);
}

// All data in database
function removeAll() {
  globalInstance.exec(`
    DELETE FROM ${IDENTITY_KEYS_TABLE};

    DELETE FROM ${ITEMS_TABLE};
    DELETE FROM unprocessed;
    DELETE FROM lastHashes;
    DELETE FROM ${NODES_FOR_PUBKEY_TABLE};
    DELETE FROM ${CLOSED_GROUP_V2_KEY_PAIRS_TABLE};
    DELETE FROM seenMessages;
    DELETE FROM ${CONVERSATIONS_TABLE};
    DELETE FROM ${MESSAGES_TABLE};
    DELETE FROM ${ATTACHMENT_DOWNLOADS_TABLE};
    DELETE FROM ${MESSAGES_FTS_TABLE};
`);
}

function removeAllConversations() {
  globalInstance.prepare(`DELETE FROM ${CONVERSATIONS_TABLE};`).run();
}

function getMessagesWithVisualMediaAttachments(conversationId, { limit }) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId AND
      hasVisualMediaAttachments = 1
     ORDER BY received_at DESC
     LIMIT $limit;`
    )
    .all({
      conversationId,
      limit,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getMessagesWithFileAttachments(conversationId, { limit }) {
  const rows = globalInstance
    .prepare(
      `SELECT json FROM ${MESSAGES_TABLE} WHERE
      conversationId = $conversationId AND
      hasFileAttachments = 1
     ORDER BY received_at DESC
     LIMIT $limit;`
    )
    .all({
      conversationId,
      limit,
    });

  return map(rows, row => jsonToObject(row.json));
}

function getExternalFilesForMessage(message) {
  const { attachments, contact, quote, preview } = message;
  const files = [];

  forEach(attachments, attachment => {
    const { path: file, thumbnail, screenshot } = attachment;
    if (file) {
      files.push(file);
    }

    if (thumbnail && thumbnail.path) {
      files.push(thumbnail.path);
    }

    if (screenshot && screenshot.path) {
      files.push(screenshot.path);
    }
  });

  if (quote && quote.attachments && quote.attachments.length) {
    forEach(quote.attachments, attachment => {
      const { thumbnail } = attachment;

      if (thumbnail && thumbnail.path) {
        files.push(thumbnail.path);
      }
    });
  }

  if (contact && contact.length) {
    forEach(contact, item => {
      const { avatar } = item;

      if (avatar && avatar.avatar && avatar.avatar.path) {
        files.push(avatar.avatar.path);
      }
    });
  }

  if (preview && preview.length) {
    forEach(preview, item => {
      const { image } = item;

      if (image && image.path) {
        files.push(image.path);
      }
    });
  }

  return files;
}

function getExternalFilesForConversation(conversation) {
  const { avatar, profileAvatar } = conversation;
  const files = [];

  if (avatar && avatar.path) {
    files.push(avatar.path);
  }

  if (profileAvatar && profileAvatar.path) {
    files.push(profileAvatar.path);
  }

  return files;
}

function removeKnownAttachments(allAttachments) {
  const lookup = fromPairs(map(allAttachments, file => [file, true]));
  const chunkSize = 50;

  const total = getMessageCount();
  console.log(`removeKnownAttachments: About to iterate through ${total} messages`);

  let count = 0;
  let complete = false;
  let id = '';

  while (!complete) {
    const rows = globalInstance
      .prepare(
        `SELECT json FROM ${MESSAGES_TABLE}
       WHERE id > $id
       ORDER BY id ASC
       LIMIT $chunkSize;`
      )
      .all({
        id,
        chunkSize,
      });

    const messages = map(rows, row => jsonToObject(row.json));
    forEach(messages, message => {
      const externalFiles = getExternalFilesForMessage(message);
      forEach(externalFiles, file => {
        delete lookup[file];
      });
    });

    const lastMessage = last(messages);
    if (lastMessage) {
      ({ id } = lastMessage);
    }
    complete = messages.length < chunkSize;
    count += messages.length;
  }

  console.log(`removeKnownAttachments: Done processing ${count} ${MESSAGES_TABLE}`);

  complete = false;
  count = 0;
  // Though conversations.id is a string, this ensures that, when coerced, this
  //   value is still a string but it's smaller than every other string.
  id = 0;

  const conversationTotal = getConversationCount();
  console.log(
    `removeKnownAttachments: About to iterate through ${conversationTotal} ${CONVERSATIONS_TABLE}`
  );

  while (!complete) {
    const rows = globalInstance
      .prepare(
        `SELECT json FROM ${CONVERSATIONS_TABLE}
       WHERE id > $id
       ORDER BY id ASC
       LIMIT $chunkSize;`
      )
      .all({
        id,
        chunkSize,
      });

    const conversations = map(rows, row => jsonToObject(row.json));
    forEach(conversations, conversation => {
      const externalFiles = getExternalFilesForConversation(conversation);
      forEach(externalFiles, file => {
        delete lookup[file];
      });
    });

    const lastMessage = last(conversations);
    if (lastMessage) {
      ({ id } = lastMessage);
    }
    complete = conversations.length < chunkSize;
    count += conversations.length;
  }

  console.log(`removeKnownAttachments: Done processing ${count} ${CONVERSATIONS_TABLE}`);

  return Object.keys(lookup);
}

function getMessagesCountByConversation(instance, conversationId) {
  const row = instance
    .prepare(`SELECT count(*) from ${MESSAGES_TABLE} WHERE conversationId = $conversationId;`)
    .get({ conversationId });

  return row ? row['count(*)'] : 0;
}

function getAllClosedGroupConversations(instance, order = true) {
  const rows = (globalInstance || instance)
    .prepare(
      `SELECT json FROM ${CONVERSATIONS_TABLE} WHERE
      type = 'group' AND
      id NOT LIKE 'publicChat:%'
     ${order ? 'ORDER BY id ASC' : ''};`
    )
    .all();

  return map(rows, row => jsonToObject(row.json));
}

function remove05PrefixFromStringIfNeeded(str) {
  if (str.length === 66 && str.startsWith('05')) {
    return str.substr(2);
  }
  return str;
}

function updateExistingClosedGroupV1ToClosedGroupV2(db) {
  // the migration is called only once, so all current groups not being open groups are v1 closed group.
  const allClosedGroupV1 = getAllClosedGroupConversations(db) || [];

  allClosedGroupV1.forEach(groupV1 => {
    const groupId = groupV1.id;
    try {
      console.log('Migrating closed group v1 to v2: pubkey', groupId);
      const groupV1IdentityKey = getIdentityKeyById(groupId, db);
      const encryptionPubKeyWithoutPrefix = remove05PrefixFromStringIfNeeded(groupV1IdentityKey.id);

      // Note:
      // this is what we get from getIdentityKeyById:
      //   {
      //     id: string;
      //     secretKey?: string;
      //   }

      // and this is what we want saved in db:
      //   {
      //    publicHex: string; // without prefix
      //    privateHex: string;
      //   }
      const keyPair = {
        publicHex: encryptionPubKeyWithoutPrefix,
        privateHex: groupV1IdentityKey.secretKey,
      };
      addClosedGroupEncryptionKeyPair(groupId, keyPair, db);
    } catch (e) {
      console.error(e);
    }
  });
}

/**
 * The returned array is ordered based on the timestamp, the latest is at the end.
 * @param {*} groupPublicKey string | PubKey
 */
function getAllEncryptionKeyPairsForGroup(groupPublicKey) {
  const rows = getAllEncryptionKeyPairsForGroupRaw(groupPublicKey);

  return map(rows, row => jsonToObject(row.json));
}

function getAllEncryptionKeyPairsForGroupRaw(groupPublicKey) {
  const pubkeyAsString = groupPublicKey.key ? groupPublicKey.key : groupPublicKey;
  const rows = globalInstance
    .prepare(
      `SELECT * FROM ${CLOSED_GROUP_V2_KEY_PAIRS_TABLE} WHERE groupPublicKey = $groupPublicKey ORDER BY timestamp ASC;`
    )
    .all({
      groupPublicKey: pubkeyAsString,
    });

  return rows;
}

function getLatestClosedGroupEncryptionKeyPair(groupPublicKey) {
  const rows = getAllEncryptionKeyPairsForGroup(groupPublicKey);
  if (!rows || rows.length === 0) {
    return undefined;
  }
  return rows[rows.length - 1];
}

function addClosedGroupEncryptionKeyPair(groupPublicKey, keypair, instance) {
  const timestamp = Date.now();

  (globalInstance || instance)
    .prepare(
      `INSERT OR REPLACE INTO ${CLOSED_GROUP_V2_KEY_PAIRS_TABLE} (
      groupPublicKey,
      timestamp,
        json
        ) values (
          $groupPublicKey,
          $timestamp,
          $json
          );`
    )
    .run({
      groupPublicKey,
      timestamp,
      json: objectToJSON(keypair),
    });
}

function removeAllClosedGroupEncryptionKeyPairs(groupPublicKey) {
  globalInstance
    .prepare(
      `DELETE FROM ${CLOSED_GROUP_V2_KEY_PAIRS_TABLE} WHERE groupPublicKey = $groupPublicKey`
    )
    .run({
      groupPublicKey,
    });
}

/**
 * Related to Opengroup V2
 */
function getAllV2OpenGroupRooms() {
  const rows = globalInstance.prepare(`SELECT json FROM ${OPEN_GROUP_ROOMS_V2_TABLE};`).all();

  return map(rows, row => jsonToObject(row.json));
}

function getV2OpenGroupRoom(conversationId) {
  const row = globalInstance
    .prepare(`SELECT * FROM ${OPEN_GROUP_ROOMS_V2_TABLE} WHERE conversationId = $conversationId;`)
    .get({
      conversationId,
    });

  if (!row) {
    return null;
  }

  return jsonToObject(row.json);
}

function getV2OpenGroupRoomByRoomId(serverUrl, roomId) {
  const row = globalInstance
    .prepare(
      `SELECT * FROM ${OPEN_GROUP_ROOMS_V2_TABLE} WHERE serverUrl = $serverUrl AND roomId = $roomId;`
    )
    .get({
      serverUrl,
      roomId,
    });

  if (!row) {
    return null;
  }

  return jsonToObject(row.json);
}

function saveV2OpenGroupRoom(opengroupsv2Room) {
  const { serverUrl, roomId, conversationId } = opengroupsv2Room;
  globalInstance
    .prepare(
      `INSERT OR REPLACE INTO ${OPEN_GROUP_ROOMS_V2_TABLE} (
      serverUrl,
      roomId,
      conversationId,
      json
    ) values (
      $serverUrl,
      $roomId,
      $conversationId,
      $json
    )`
    )
    .run({
      serverUrl,
      roomId,
      conversationId,
      json: objectToJSON(opengroupsv2Room),
    });
}

function removeV2OpenGroupRoom(conversationId) {
  globalInstance
    .prepare(`DELETE FROM ${OPEN_GROUP_ROOMS_V2_TABLE} WHERE conversationId = $conversationId`)
    .run({
      conversationId,
    });
}

function removeOneOpenGroupV1Message() {
  const row = globalInstance
    .prepare(
      `SELECT count(*) from ${MESSAGES_TABLE} WHERE
    conversationId LIKE 'publicChat:1@%';`
    )
    .get();
  const toRemoveCount = row['count(*)'];

  if (toRemoveCount <= 0) {
    return 0;
  }
  console.info('left opengroupv1 message to remove: ', toRemoveCount);
  const rowMessageIds = globalInstance
    .prepare(
      `SELECT id from ${MESSAGES_TABLE} WHERE conversationId LIKE 'publicChat:1@%' ORDER BY id LIMIT 1;`
    )
    .all();

  const messagesIds = map(rowMessageIds, r => r.id)[0];

  console.time('removeOneOpenGroupV1Message');

  removeMessage(messagesIds);
  console.timeEnd('removeOneOpenGroupV1Message');

  return toRemoveCount - 1;
}

/**
 * Only using this for development. Populate conversation and message tables.
 * @param {*} numConvosToAdd
 * @param {*} numMsgsToAdd
 */
function fillWithTestData(numConvosToAdd, numMsgsToAdd) {
  const convoBeforeCount = globalInstance
    .prepare(`SELECT count(*) from ${CONVERSATIONS_TABLE};`)
    .get()['count(*)'];

  const lipsum =
    // eslint:disable-next-line max-line-length
    `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Duis ac ornare lorem,
    non suscipit      purus. Lorem ipsum dolor sit amet, consectetur adipiscing elit.
    Suspendisse cursus aliquet       velit a dignissim. Integer at nisi sed velit consequat
    dictum. Phasellus congue tellus ante.        Ut rutrum hendrerit dapibus. Fusce
    luctus, ante nec interdum molestie, purus urna volutpat         turpis, eget mattis
    lectus velit at velit. Praesent vel tellus turpis. Praesent eget purus          at
    nisl blandit pharetra.  Cras dapibus sem vitae rutrum dapibus. Vivamus vitae mi
    ante.           Donec aliquam porta nibh, vel scelerisque orci condimentum sed.
    Proin in mattis ipsum,            ac euismod sem. Donec malesuada sem nisl, at
    vehicula ante efficitur sed. Curabitur             in sapien eros. Morbi tempor ante ut
    metus scelerisque condimentum. Integer sit amet              tempus nulla. Vivamus
    imperdiet dui ac luctus vulputate.  Sed a accumsan risus. Nulla               facilisi.
    Nulla mauris dui, luctus in sagittis at, sodales id mauris. Integer efficitur
            viverra ex, ut dignissim eros tincidunt placerat. Sed facilisis gravida
    mauris in luctus                . Fusce dapibus, est vitae tincidunt eleifend, justo
    odio porta dui, sed ultrices mi arcu                 vitae ante. Mauris ut libero
    erat. Nam ut mi quis ante tincidunt facilisis sit amet id enim.
    Vestibulum in molestie mi. In ac felis est. Vestibulum vel blandit ex. Morbi vitae
    viverra augue                  . Ut turpis quam, cursus quis ex a, convallis
    ullamcorper purus.  Nam eget libero arcu. Integer fermentum enim nunc, non consequat urna
    fermentum condimentum. Nulla vitae malesuada est. Donec imperdiet tortor interdum
    malesuada feugiat. Integer pulvinar dui ex, eget tristique arcu mattis at. Nam eu neque
    eget mauris varius suscipit. Quisque ac enim vitae mauris laoreet congue nec sed
    justo. Curabitur fermentum quam eget est tincidunt, at faucibus lacus maximus.  Donec
    auctor enim dolor, faucibus egestas diam consectetur sed. Donec eget rutrum arcu, at
    tempus mi. Fusce quis volutpat sapien. In aliquet fringilla purus. Ut eu nunc non
    augue lacinia ultrices at eget tortor. Maecenas pulvinar odio sit amet purus
    elementum, a vehicula lorem maximus. Pellentesque eu lorem magna. Vestibulum ut facilisis
    lorem. Proin et enim cursus, vulputate neque sit amet, posuere enim. Praesent
    faucibus tellus vel mi tincidunt, nec malesuada nibh malesuada. In laoreet sapien vitae
    aliquet sollicitudin.
    `;

  const msgBeforeCount = globalInstance.prepare(`SELECT count(*) from ${MESSAGES_TABLE};`).get()[
    'count(*)'
  ];

  console.info('==== fillWithTestData ====');
  console.info({
    convoBeforeCount,
    msgBeforeCount,
    convoToAdd: numConvosToAdd,
    msgToAdd: numMsgsToAdd,
  });

  const convosIdsAdded = [];
  // eslint-disable-next-line no-plusplus
  for (let index = 0; index < numConvosToAdd; index++) {
    const activeAt = Date.now() - index;
    const id = Date.now() - 1000 * index;
    const convoObjToAdd = {
      active_at: activeAt,
      members: [],
      profileName: `${activeAt}`,
      name: `${activeAt}`,
      id: `05${id}`,
      type: 'group',
    };
    convosIdsAdded.push(id);
    try {
      saveConversation(convoObjToAdd);
      // eslint-disable-next-line no-empty
    } catch (e) {}
  }
  console.warn('convosIdsAdded', convosIdsAdded);
  // eslint-disable-next-line no-plusplus
  for (let index = 0; index < numMsgsToAdd; index++) {
    const activeAt = Date.now() - index;
    const id = Date.now() - 1000 * index;

    const lipsumStartIdx = Math.floor(Math.random() * lipsum.length);
    const lipsumLength = Math.floor(Math.random() * lipsum.length - lipsumStartIdx);
    const fakeBodyText = lipsum.substring(lipsumStartIdx, lipsumStartIdx + lipsumLength);

    const convoId = convosIdsAdded[Math.floor(Math.random() * convosIdsAdded.length)];
    const msgObjToAdd = {
      // body: `fake body ${activeAt}`,
      body: `fakeMsgIdx-spongebob-${index} ${fakeBodyText} ${activeAt}`,
      conversationId: `${convoId}`,
      // eslint-disable-next-line camelcase
      expires_at: 0,
      hasAttachments: 0,
      hasFileAttachments: 0,
      hasVisualMediaAttachments: 0,
      id: `${id}`,
      serverId: 0,
      serverTimestamp: 0,
      // eslint-disable-next-line camelcase
      received_at: Date.now(),
      sent: 0,
      // eslint-disable-next-line camelcase
      sent_at: Date.now(),
      source: `${convoId}`,
      sourceDevice: 1,
      type: '%',
      unread: 1,
      expireTimer: 0,
      expirationStartTimestamp: 0,
    };

    if (convoId % 10 === 0) {
      console.info('uyo , convoId ', { index, convoId });
    }

    try {
      saveMessage(msgObjToAdd);
      // eslint-disable-next-line no-empty
    } catch (e) {
      console.error(e);
    }
  }

  const convoAfterCount = globalInstance
    .prepare(`SELECT count(*) from ${CONVERSATIONS_TABLE};`)
    .get()['count(*)'];

  const msgAfterCount = globalInstance.prepare(`SELECT count(*) from ${MESSAGES_TABLE};`).get()[
    'count(*)'
  ];

  console.info({ convoAfterCount, msgAfterCount });
  return convosIdsAdded;
}
