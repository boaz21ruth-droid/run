import { PlusOutlined } from "@ant-design/icons";
import { ApiError } from "@werun/api-client";
import { App as AntdApp, Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Row, Select, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { emptyCategory, toCreateEventRequest, toNamePath, type EventFormValues } from "../events/eventForm";
import { useCreateEvent } from "../events/queries";

const NAME_LABEL_KEYS = { zh: "form.nameZh", en: "form.nameEn", km: "form.nameKm" } as const;
const NAME_LANGS = ["zh", "en", "km"] as const;

export function EventCreatePage() {
  const { t } = useTranslation("admin");
  const [form] = Form.useForm<EventFormValues>();
  const create = useCreateEvent();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const required = [{ required: true, message: t("form.required") }];

  const onFinish = (values: EventFormValues) => {
    create.mutate(toCreateEventRequest(values), {
      onSuccess: () => {
        void message.success(t("form.created"));
        void navigate("/events");
      },
      onError: (error) => {
        if (error instanceof ApiError) {
          // 字段路径来自服务端（见 §C17-9），无法用 antd 的字面量 NamePath 类型静态表达
          form.setFields(
            Object.entries(error.fields).map(([field, text]) => ({ name: toNamePath(field), errors: [text] })) as Parameters<
              typeof form.setFields
            >[0],
          );
        }
      },
    });
  };

  return (
    <Card title={t("form.title")}>
      {create.error ? <Alert type="error" showIcon message={create.error.message} style={{ marginBottom: 16 }} /> : null}
      <Form<EventFormValues>
        form={form}
        name="event"
        layout="vertical"
        onFinish={onFinish}
        disabled={create.isPending}
        initialValues={{ eventType: "RACE", organizerType: "OFFICIAL", categories: [emptyCategory()] }}
      >
        <Form.Item name="slug" label={t("form.slug")} extra={t("form.slugHelp")} rules={required}>
          <Input />
        </Form.Item>

        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="eventType" label={t("form.eventType")} rules={required}>
              <Select
                options={[
                  { value: "RACE", label: t("eventType.RACE") },
                  { value: "FREE_ACTIVITY", label: t("eventType.FREE_ACTIVITY") },
                ]}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="organizerType" label={t("form.organizerType")} rules={required}>
              <Select
                options={[
                  { value: "OFFICIAL", label: t("organizerType.OFFICIAL") },
                  { value: "PARTNER", label: t("organizerType.PARTNER") },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>

        <Typography.Text strong>{t("form.name")}</Typography.Text>
        <Row gutter={16}>
          {NAME_LANGS.map((lang) => (
            <Col key={lang} xs={24} md={8}>
              <Form.Item name={["name", lang]} label={t(NAME_LABEL_KEYS[lang])} rules={required}>
                <Input lang={lang} />
              </Form.Item>
            </Col>
          ))}
        </Row>

        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item name="city" label={t("form.city")} rules={required}>
              <Input />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item name="raceDate" label={t("form.raceDate")} rules={required}>
              <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>

        <Typography.Title level={5}>{t("form.categories")}</Typography.Title>
        <Form.List name="categories">
          {(fields, { add, remove }) => (
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              {fields.map((field) => (
                <Card
                  key={field.key}
                  size="small"
                  extra={
                    <Button type="link" danger onClick={() => remove(field.name)}>
                      {t("form.removeCategory")}
                    </Button>
                  }
                >
                  <Row gutter={16}>
                    <Col xs={24} md={6}>
                      <Form.Item name={[field.name, "code"]} label={t("form.categoryCode")} rules={required}>
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={9}>
                      <Form.Item name={[field.name, "distanceM"]} label={t("form.distanceM")} rules={required}>
                        <InputNumber min={1} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={9}>
                      <Form.Item name={[field.name, "capacity"]} label={t("form.capacity")} rules={required}>
                        <InputNumber min={1} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Row gutter={16}>
                    {NAME_LANGS.map((lang) => (
                      <Col key={lang} xs={24} md={8}>
                        <Form.Item
                          name={[field.name, "name", lang]}
                          label={`${t("form.categoryName")} · ${t(NAME_LABEL_KEYS[lang])}`}
                          rules={required}
                        >
                          <Input lang={lang} />
                        </Form.Item>
                      </Col>
                    ))}
                  </Row>
                  <Row gutter={16}>
                    <Col xs={24} md={12}>
                      <Form.Item name={[field.name, "startAt"]} label={t("form.startAt")}>
                        <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12}>
                      <Form.Item name={[field.name, "cutoffAt"]} label={t("form.cutoffAt")}>
                        <DatePicker showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>
              ))}
              <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add(emptyCategory())}>
                {t("form.addCategory")}
              </Button>
            </Space>
          )}
        </Form.List>

        <Space style={{ marginTop: 24 }}>
          <Button onClick={() => void navigate("/events")}>{t("common:action.back")}</Button>
          <Button type="primary" htmlType="submit" loading={create.isPending} data-testid="event-form-submit">
            {t("form.submit")}
          </Button>
        </Space>
      </Form>
    </Card>
  );
}
