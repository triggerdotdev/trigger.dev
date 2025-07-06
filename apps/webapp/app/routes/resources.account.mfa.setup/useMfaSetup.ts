import { useReducer, useEffect } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { action } from "./route";

export type MfaPhase = 'idle' | 'enabling' | 'validating' | 'showing-recovery' | 'disabling';

export interface MfaState {
  phase: MfaPhase;
  isEnabled: boolean;
  setupData?: {
    secret: string;
    otpAuthUrl: string;
  };
  recoveryCodes?: string[];
  error?: string;
  isSubmitting: boolean;
  disableMethod: 'totp' | 'recovery';
}

export type MfaAction = 
  | { type: 'ENABLE_MFA' }
  | { type: 'SETUP_DATA_RECEIVED'; setupData: { secret: string; otpAuthUrl: string } }
  | { type: 'CANCEL_SETUP' }
  | { type: 'VALIDATE_TOTP'; code: string }
  | { type: 'VALIDATION_SUCCESS'; recoveryCodes: string[] }
  | { type: 'VALIDATION_FAILED'; error: string; setupData: { secret: string; otpAuthUrl: string } }
  | { type: 'RECOVERY_CODES_SAVED' }
  | { type: 'OPEN_DISABLE_DIALOG' }
  | { type: 'DISABLE_MFA' }
  | { type: 'DISABLE_SUCCESS' }
  | { type: 'DISABLE_FAILED'; error: string }
  | { type: 'CANCEL_DISABLE' }
  | { type: 'SET_DISABLE_METHOD'; method: 'totp' | 'recovery' }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_SUBMITTING'; isSubmitting: boolean };

function mfaReducer(state: MfaState, action: MfaAction): MfaState {
  switch (action.type) {
    case 'ENABLE_MFA':
      return {
        ...state,
        phase: 'enabling',
        isSubmitting: true,
        error: undefined,
      };

    case 'SETUP_DATA_RECEIVED':
      return {
        ...state,
        phase: 'enabling',
        setupData: action.setupData,
        error: undefined,
        isSubmitting: false,
      };

    case 'CANCEL_SETUP':
      return {
        ...state,
        phase: 'idle',
        setupData: undefined,
        error: undefined,
        isSubmitting: false,
      };

    case 'VALIDATE_TOTP':
      return {
        ...state,
        phase: 'validating',
        isSubmitting: true,
        error: undefined,
      };

    case 'VALIDATION_SUCCESS':
      return {
        ...state,
        phase: 'showing-recovery',
        recoveryCodes: action.recoveryCodes,
        isSubmitting: false,
        isEnabled: true,
        error: undefined,
      };

    case 'VALIDATION_FAILED':
      return {
        ...state,
        phase: 'enabling',
        setupData: action.setupData,
        error: action.error,
        isSubmitting: false,
      };

    case 'RECOVERY_CODES_SAVED':
      return {
        ...state,
        phase: 'idle',
        setupData: undefined,
        recoveryCodes: undefined,
        isSubmitting: false,
      };

    case 'OPEN_DISABLE_DIALOG':
      return {
        ...state,
        phase: 'disabling',
        error: undefined,
        isSubmitting: false,
      };

    case 'DISABLE_MFA':
      return {
        ...state,
        isSubmitting: true,
        error: undefined,
      };

    case 'DISABLE_SUCCESS':
      return {
        ...state,
        phase: 'idle',
        isEnabled: false,
        error: undefined,
        isSubmitting: false,
      };

    case 'DISABLE_FAILED':
      return {
        ...state,
        error: action.error,
        isSubmitting: false,
      };

    case 'CANCEL_DISABLE':
      return {
        ...state,
        phase: 'idle',
        error: undefined,
        isSubmitting: false,
      };

    case 'SET_DISABLE_METHOD':
      return {
        ...state,
        disableMethod: action.method,
        error: undefined,
      };

    case 'SET_ERROR':
      return {
        ...state,
        error: action.error,
      };

    case 'CLEAR_ERROR':
      return {
        ...state,
        error: undefined,
      };

    case 'SET_SUBMITTING':
      return {
        ...state,
        isSubmitting: action.isSubmitting,
      };

    default:
      return state;
  }
}

export function useMfaSetup(initialIsEnabled: boolean) {
  const fetcher = useTypedFetcher<typeof action>();
  
  const [state, dispatch] = useReducer(mfaReducer, {
    phase: 'idle',
    isEnabled: initialIsEnabled,
    isSubmitting: false,
    disableMethod: 'totp',
  });

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.data) {
      const { data } = fetcher;
      
      switch (data.action) {
        case 'enable-mfa':
          dispatch({ 
            type: 'SETUP_DATA_RECEIVED', 
            setupData: { secret: data.secret, otpAuthUrl: data.otpAuthUrl }
          });
          break;
          
        case 'validate-totp':
          if (data.success) {
            dispatch({ 
              type: 'VALIDATION_SUCCESS', 
              recoveryCodes: data.recoveryCodes || []
            });
          } else {
            dispatch({ 
              type: 'VALIDATION_FAILED', 
              error: data.error || 'Invalid code',
              setupData: { secret: data.secret!, otpAuthUrl: data.otpAuthUrl! }
            });
          }
          break;
          
        case 'disable-mfa':
          if (data.success) {
            dispatch({ type: 'DISABLE_SUCCESS' });
          } else {
            dispatch({ 
              type: 'DISABLE_FAILED', 
              error: data.error || 'Failed to disable MFA'
            });
          }
          break;
          
        case 'cancel-totp':
          dispatch({ type: 'CANCEL_SETUP' });
          break;
      }
    }
  }, [fetcher.data]);

  // Handle submitting state
  useEffect(() => {
    dispatch({ type: 'SET_SUBMITTING', isSubmitting: fetcher.state === 'submitting' });
  }, [fetcher.state]);

  const actions = {
    enableMfa: () => {
      dispatch({ type: 'ENABLE_MFA' });
      fetcher.submit(
        { action: 'enable-mfa' },
        { method: 'POST', action: '/resources/account/mfa/setup' }
      );
    },

    cancelSetup: () => {
      dispatch({ type: 'CANCEL_SETUP' });
      fetcher.submit(
        { action: 'cancel-totp' },
        { method: 'POST', action: '/resources/account/mfa/setup' }
      );
    },

    validateTotp: (code: string) => {
      dispatch({ type: 'VALIDATE_TOTP', code });
      fetcher.submit(
        { action: 'validate-totp', totpCode: code },
        { method: 'POST', action: '/resources/account/mfa/setup' }
      );
    },

    saveRecoveryCodes: () => {
      dispatch({ type: 'RECOVERY_CODES_SAVED' });
      fetcher.submit(
        { action: 'saved-recovery-codes' },
        { method: 'POST', action: '/resources/account/mfa/setup' }
      );
    },

    openDisableDialog: () => {
      dispatch({ type: 'OPEN_DISABLE_DIALOG' });
    },

    disableMfa: (totpCode?: string, recoveryCode?: string) => {
      dispatch({ type: 'DISABLE_MFA' });
      const formData: Record<string, string> = { action: 'disable-mfa' };
      if (totpCode) formData.totpCode = totpCode;
      if (recoveryCode) formData.recoveryCode = recoveryCode;
      
      fetcher.submit(
        formData,
        { method: 'POST', action: '/resources/account/mfa/setup' }
      );
    },

    cancelDisable: () => {
      dispatch({ type: 'CANCEL_DISABLE' });
    },

    setDisableMethod: (method: 'totp' | 'recovery') => {
      dispatch({ type: 'SET_DISABLE_METHOD', method });
    },

    clearError: () => {
      dispatch({ type: 'CLEAR_ERROR' });
    },
  };

  return {
    state,
    actions,
    // Computed properties for easier access
    isQrDialogOpen: state.phase === 'enabling' && !!state.setupData,
    isRecoveryDialogOpen: state.phase === 'showing-recovery' && !!state.recoveryCodes,
    isDisableDialogOpen: state.phase === 'disabling',
  };
}