import { EmailIcon, WarningIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { Client } from "@shared/types";
import ButtonLarge from "~/components/ButtonLarge";
import InputLarge from "~/components/InputLarge";
import Notice from "~/components/Notice";
import PluginIcon from "~/components/PluginIcon";
import { client } from "~/utils/ApiClient";
import Desktop from "~/utils/Desktop";
import { describeError } from "~/utils/describeError";
import type { ErrorDescription } from "~/utils/describeError";
import { getRedirectUrl } from "~/utils/urls";
import { PasskeyAuthenticationProvider } from "./PasskeyAuthenticationProvider";

type Props = React.ComponentProps<typeof ButtonLarge> & {
  id: string;
  name: string;
  authUrl: string;
  isCreate: boolean;
  onEmailSuccess: (email: string) => void;
  preferOTP: boolean;
};

type AuthState = "initial" | "email" | "code";

function AuthenticationProvider(props: Props) {
  const { t } = useTranslation();
  const [authState, setAuthState] = React.useState<AuthState>("initial");
  const [isSubmitting, setSubmitting] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [failure, setFailure] = React.useState<ErrorDescription | undefined>();
  const { isCreate, id, name, authUrl, onEmailSuccess, preferOTP, ...rest } =
    props;
  const clientType = Desktop.isElectron() ? Client.Desktop : Client.Web;

  const handleChangeEmail = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    setFailure(undefined);
  };

  const handleSubmitEmail = async (
    event: React.SyntheticEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (authState === "email" && email) {
      setSubmitting(true);
      setFailure(undefined);

      try {
        const response = await client.post(event.currentTarget.action, {
          email,
          client: clientType,
          preferOTP,
        });

        if (response.redirect) {
          window.location.href = response.redirect;
        } else {
          setSubmitting(false);
          onEmailSuccess?.(email);
        }
      } catch (err) {
        setSubmitting(false);
        setFailure(describeError(t, err));
      }
    } else {
      setAuthState("email");
    }
  };

  const href = getRedirectUrl(authUrl);

  if (id === "passkeys") {
    return <PasskeyAuthenticationProvider {...rest} />;
  }

  if (id === "email") {
    if (isCreate) {
      return null;
    }

    return (
      <Wrapper>
        {failure && (
          <div role="alert">
            <Notice
              icon={<WarningIcon />}
              description={failure.hint ? <>{failure.hint}</> : undefined}
            >
              {failure.title}
            </Notice>
          </div>
        )}
        <Form method="POST" action="/auth/email" onSubmit={handleSubmitEmail}>
          {authState === "email" ? (
            <>
              <InputLarge
                type="email"
                name="email"
                placeholder="me@domain.com"
                value={email}
                onChange={handleChangeEmail}
                disabled={isSubmitting}
                autoFocus
                required
                short
              />
              <ButtonLarge type="submit" disabled={isSubmitting} {...rest}>
                {t("Sign In")} →
              </ButtonLarge>
            </>
          ) : (
            <ButtonLarge type="submit" icon={<EmailIcon />} fullwidth {...rest}>
              {t("Continue with Email")}
            </ButtonLarge>
          )}
        </Form>
      </Wrapper>
    );
  }

  return (
    <ButtonLarge
      onClick={() => (window.location.href = href)}
      icon={<PluginIcon id={id} />}
      fullwidth
      {...rest}
    >
      {t("Continue with {{ authProviderName }}", {
        authProviderName: name,
      })}
    </ButtonLarge>
  );
}

const Wrapper = styled.div`
  width: 100%;
`;

const Form = styled.form`
  width: 100%;
  display: flex;
  justify-content: space-between;
`;

export default AuthenticationProvider;
