import React, { useContext, useState } from 'react';
import { sanitizeSessionUsername } from '../../session/utils/String';
import { Flex } from '../basic/Flex';
import { SessionButton, SessionButtonColor, SessionButtonType } from '../basic/SessionButton';
import { SessionSpinner } from '../basic/SessionSpinner';
import { SpacerLG } from '../basic/Text';
import {
  RegistrationContext,
  RegistrationPhase,
  signInWithLinking,
  signInWithRecovery,
} from './RegistrationStages';
import { RegistrationUserDetails } from './RegistrationUserDetails';
import { GoBackMainMenuButton } from './SignUpTab';
import { TermsAndConditions } from './TermsAndConditions';

export enum SignInMode {
  Default,
  UsingRecoveryPhrase,
  LinkDevice,
}
// tslint:disable: use-simple-attributes
// tslint:disable: react-unused-props-and-state

const LinkDeviceButton = (props: { onLinkDeviceButtonClicked: () => any }) => {
  return (
    <SessionButton
      onClick={props.onLinkDeviceButtonClicked}
      buttonType={SessionButtonType.BrandOutline}
      buttonColor={SessionButtonColor.Green}
      text={window.i18n('linkDevice')}
    />
  );
};

const RestoreUsingRecoveryPhraseButton = (props: { onRecoveryButtonClicked: () => any }) => {
  return (
    <SessionButton
      onClick={props.onRecoveryButtonClicked}
      buttonType={SessionButtonType.BrandOutline}
      buttonColor={SessionButtonColor.Green}
      text={window.i18n('restoreUsingRecoveryPhrase')}
      dataTestId="restore-using-recovery"
    />
  );
};

const ContinueYourSessionButton = (props: {
  handleContinueYourSessionClick: () => any;
  disabled: boolean;
}) => {
  return (
    <SessionButton
      onClick={props.handleContinueYourSessionClick}
      buttonType={SessionButtonType.Brand}
      buttonColor={SessionButtonColor.Green}
      text={window.i18n('continueYourSession')}
      disabled={props.disabled}
      dataTestId="continue-session-button;"
    />
  );
};

const SignInContinueButton = (props: {
  signInMode: SignInMode;
  disabled: boolean;
  handleContinueYourSessionClick: () => any;
}) => {
  if (props.signInMode === SignInMode.Default) {
    return null;
  }
  return (
    <ContinueYourSessionButton
      handleContinueYourSessionClick={props.handleContinueYourSessionClick}
      disabled={props.disabled}
    />
  );
};

const SignInButtons = (props: {
  signInMode: SignInMode;
  onRecoveryButtonClicked: () => any;
  onLinkDeviceButtonClicked: () => any;
}) => {
  if (props.signInMode !== SignInMode.Default) {
    return null;
  }
  return (
    <div>
      <RestoreUsingRecoveryPhraseButton onRecoveryButtonClicked={props.onRecoveryButtonClicked} />
      <SpacerLG />
      <LinkDeviceButton onLinkDeviceButtonClicked={props.onLinkDeviceButtonClicked} />
    </div>
  );
};

export const SignInTab = () => {
  const { setRegistrationPhase, signInMode, setSignInMode } = useContext(RegistrationContext);

  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [recoveryPhraseError, setRecoveryPhraseError] = useState(undefined as string | undefined);
  const [displayName, setDisplayName] = useState('');
  const [displayNameError, setDisplayNameError] = useState<string | undefined>('');
  const [loading, setIsLoading] = useState(false);

  const isRecovery = signInMode === SignInMode.UsingRecoveryPhrase;
  const isLinking = signInMode === SignInMode.LinkDevice;
  const showTermsAndConditions = signInMode !== SignInMode.Default;

  // show display name input only if we are trying to recover from seed.
  // We don't need a display name when we link a device, as the display name
  // from the configuration message will be used.
  const showDisplayNameField = isRecovery;

  // Display name is required only on isRecoveryMode
  const displayNameOK = (isRecovery && !displayNameError && !!displayName) || isLinking;

  // Seed is mandatory no matter which mode
  const seedOK = recoveryPhrase && !recoveryPhraseError;

  const activateContinueButton = seedOK && displayNameOK && !loading;

  const continueYourSession = async () => {
    if (isRecovery) {
      await signInWithRecovery({
        displayName,
        userRecoveryPhrase: recoveryPhrase,
      });
    } else if (isLinking) {
      setIsLoading(true);
      await signInWithLinking({
        userRecoveryPhrase: recoveryPhrase,
      });
      setIsLoading(false);
    }
  };

  return (
    <div className="session-registration__content">
      {signInMode !== SignInMode.Default && (
        <>
          <GoBackMainMenuButton />

          <RegistrationUserDetails
            showDisplayNameField={showDisplayNameField}
            showSeedField={true}
            displayName={displayName}
            handlePressEnter={continueYourSession}
            onDisplayNameChanged={(name: string) => {
              const sanitizedName = sanitizeSessionUsername(name);
              const trimName = sanitizedName.trim();
              setDisplayName(sanitizedName);
              setDisplayNameError(!trimName ? window.i18n('displayNameEmpty') : undefined);
            }}
            onSeedChanged={(seed: string) => {
              setRecoveryPhrase(seed);
              setRecoveryPhraseError(!seed ? window.i18n('recoveryPhraseEmpty') : undefined);
            }}
            recoveryPhrase={recoveryPhrase}
            stealAutoFocus={true}
          />
        </>
      )}

      <SignInButtons
        signInMode={signInMode}
        onRecoveryButtonClicked={() => {
          setRegistrationPhase(RegistrationPhase.SignIn);
          setSignInMode(SignInMode.UsingRecoveryPhrase);
          setRecoveryPhrase('');
          setDisplayName('');
          setIsLoading(false);
        }}
        onLinkDeviceButtonClicked={() => {
          setRegistrationPhase(RegistrationPhase.SignIn);
          setSignInMode(SignInMode.LinkDevice);
          setRecoveryPhrase('');
          setDisplayName('');
          setIsLoading(false);
        }}
      />
      <SignInContinueButton
        signInMode={signInMode}
        handleContinueYourSessionClick={continueYourSession}
        disabled={!activateContinueButton}
      />
      {loading && (
        <Flex
          container={true}
          justifyContent="center"
          alignItems="center"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            pointerEvents: 'all',
            backgroundColor: '#00000088',
          }}
        >
          <SessionSpinner loading={true} />
        </Flex>
      )}

      {showTermsAndConditions && <TermsAndConditions />}
    </div>
  );
};
