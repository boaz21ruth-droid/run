import type { Schemas } from "@werun/api-client";
import type { Dayjs } from "dayjs";
import { fromEventWallClockOrNull, toEventWallClockOrNull } from "../time/eventTime";

export interface RegistrationFormValues {
  open: boolean;
  opensAt?: Dayjs | null;
  closesAt?: Dayjs | null;
}

type RegistrationFields = Pick<Schemas["AdminEvent"], "registrationOpen" | "registrationOpensAt" | "registrationClosesAt">;

/** 报名开放 / 截止时间按赛事时区回填 */
export function fromEventRegistration(event: RegistrationFields, tz: string): RegistrationFormValues {
  return {
    open: event.registrationOpen,
    opensAt: toEventWallClockOrNull(event.registrationOpensAt, tz),
    closesAt: toEventWallClockOrNull(event.registrationClosesAt, tz),
  };
}

export function toRegistrationRequest(values: RegistrationFormValues, tz: string): Schemas["UpdateEventRegistrationRequest"] {
  return {
    open: values.open,
    opensAt: fromEventWallClockOrNull(values.opensAt, tz),
    closesAt: fromEventWallClockOrNull(values.closesAt, tz),
  };
}
