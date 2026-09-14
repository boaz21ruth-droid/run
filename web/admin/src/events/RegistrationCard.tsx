import { ApiError, type Schemas } from "@werun/api-client";
import { App as AntdApp, Alert, Button, Card, Col, DatePicker, Form, Row, Switch } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";
import { useUpdateEventRegistration } from "./queries";

interface RegistrationFormValues {
  open: boolean;
  opensAt?: Dayjs | null;
  closesAt?: Dayjs | null;
}

interface RegistrationCardProps {
  event: Schemas["AdminEvent"];
  canWrite: boolean;
}

export function RegistrationCard({ event, canWrite }: RegistrationCardProps) {
  const { t } = useTranslation("admin");
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RegistrationFormValues>();
  const update = useUpdateEventRegistration(event.id);

  const error = update.error instanceof ApiError ? update.error : null;
  const notReady = error?.code === "REGISTRATION_NOT_READY" ? error : null;
  const otherError = update.error && !notReady && error?.code !== "VALIDATION_FAILED" ? update.error : null;

  const onFinish = (values: RegistrationFormValues) => {
    update.mutate(
      {
        open: values.open,
        opensAt: values.opensAt ? values.opensAt.toISOString() : null,
        closesAt: values.closesAt ? values.closesAt.toISOString() : null,
      },
      {
        onSuccess: () => void message.success(t("eventDetail.registration.saved")),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "VALIDATION_FAILED") {
            form.setFields(
              Object.entries(err.fields).map(([name, text]) => ({
                name: name as keyof RegistrationFormValues,
                errors: [text],
              })),
            );
          }
        },
      },
    );
  };

  return (
    <Card title={t("eventDetail.registration.title")}>
      {notReady ? (
        <div data-testid="event-registration-not-ready" style={{ marginBottom: 16 }}>
          <Alert
            type="warning"
            showIcon
            message={notReady.message}
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {Object.entries(notReady.fields).map(([field, text]) => (
                  <li key={field}>{text}</li>
                ))}
              </ul>
            }
          />
        </div>
      ) : null}
      {otherError ? <Alert type="error" showIcon message={otherError.message} style={{ marginBottom: 16 }} /> : null}
      <Form<RegistrationFormValues>
        form={form}
        name="registration"
        layout="vertical"
        onFinish={onFinish}
        disabled={!canWrite || update.isPending}
        initialValues={{
          open: event.registrationOpen,
          opensAt: event.registrationOpensAt ? dayjs(event.registrationOpensAt) : null,
          closesAt: event.registrationClosesAt ? dayjs(event.registrationClosesAt) : null,
        }}
      >
        <Form.Item name="open" label={t("eventDetail.registration.open")} valuePropName="checked">
          <Switch data-testid="event-registration-switch" />
        </Form.Item>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="opensAt" label={t("eventDetail.registration.opensAt")} extra={t("eventDetail.registration.timeHelp")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="closesAt" label={t("eventDetail.registration.closesAt")} extra={t("eventDetail.registration.timeHelp")}>
              <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
        {canWrite ? (
          <Button type="primary" htmlType="submit" loading={update.isPending} data-testid="event-registration-save">
            {t("eventDetail.registration.save")}
          </Button>
        ) : null}
      </Form>
    </Card>
  );
}
