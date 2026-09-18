import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  errorMessage,
  fetchMe,
  getPublicConfig,
  setUnauthorizedHandler,
  signInWithGoogle,
  tokenStore,
} from '../services/api';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

const AuthContext = createContext(null);

/** Load the Google Identity Services script once, shared by every caller. */
let gsiPromise = null;
const loadGoogleScript = () => {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    const script = existing || document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () =>
      window.google?.accounts?.id
        ? resolve(window.google)
        : reject(new Error('Google Sign-In failed to initialise.'));
    script.onerror = () => {
      gsiPromise = null;
      reject(new Error('Could not load Google Sign-In. Check your connection or ad blocker.'));
    };
    if (!existing) document.head.appendChild(script);
  });
  return gsiPromise;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const initializedRef = useRef(false);
  // The credential callback is handed to Google once and must not go stale, so
  // it is read through a ref rather than captured at initialize() time.
  const credentialHandlerRef = useRef(null);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    try {
      window.google?.accounts?.id?.disableAutoSelect();
    } catch (err) {
      /* nothing to disable */
    }
  }, []);

  // A 401 from any request means the session is gone; drop it everywhere.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Boot: read the server config, then restore the session if there is one.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      let publicConfig = null;
      try {
        publicConfig = await getPublicConfig();
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err, 'Cannot reach the server.'));
        setStatus('error');
        return;
      }
      if (cancelled) return;
      setConfig(publicConfig);

      if (tokenStore.get()) {
        try {
          const me = await fetchMe();
          if (!cancelled) setUser(me);
        } catch (err) {
          tokenStore.clear();
        }
      }
      if (!cancelled) setStatus('ready');
    })();

    return () => { cancelled = true; };
  }, []);

  const handleCredential = useCallback(async (credential) => {
    setSigningIn(true);
    setError('');
    try {
      const result = await signInWithGoogle(credential);
      tokenStore.set(result.access_token);
      setUser(result.user);
      return true;
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed. Please try again.'));
      return false;
    } finally {
      setSigningIn(false);
    }
  }, []);

  // Keep the ref pointing at the current handler without re-initializing GSI.
  credentialHandlerRef.current = handleCredential;

  /** Render Google's button into `element`. */
  const renderSignInButton = useCallback(
    async (element) => {
      if (!element) return;
      const clientId = config?.google_client_id;
      if (!clientId) {
        setError('Google Sign-In is not configured on the server (GOOGLE_CLIENT_ID is missing).');
        return;
      }

      try {
        const google = await loadGoogleScript();
        // initialize() must run exactly once. Calling it again detaches the
        // callback from any button already rendered, so a click goes nowhere.
        if (!initializedRef.current) {
          google.accounts.id.initialize({
            client_id: clientId,
            callback: ({ credential }) => credentialHandlerRef.current?.(credential),
            auto_select: false,
            cancel_on_tap_outside: true,
            // Ask for FedCM, where the browser shows its own account chooser
            // instead of opening a popup window. A blocked popup is the single
            // most common way this flow fails, and FedCM removes the popup from
            // the picture entirely. Browsers without it fall back to the popup,
            // and older GSI builds simply ignore these flags.
            use_fedcm_for_button: true,
            use_fedcm_for_prompt: true,
          });
          initializedRef.current = true;
        }
        element.innerHTML = '';
        // Google takes a pixel width, so fit it to the card rather than let a
        // fixed 280 overflow a narrow phone.
        const available = element.parentElement?.clientWidth || element.clientWidth || 280;
        google.accounts.id.renderButton(element, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          width: Math.max(200, Math.min(320, Math.floor(available))),
          logo_alignment: 'left',
        });
      } catch (err) {
        setError(err.message || 'Could not load Google Sign-In.');
      }
    },
    [config],
  );

  const value = useMemo(
    () => ({
      user,
      config,
      status,
      error,
      signingIn,
      isAuthenticated: !!user,
      signOut,
      renderSignInButton,
      clearError: () => setError(''),
    }),
    [user, config, status, error, signingIn, signOut, renderSignInButton],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
};
