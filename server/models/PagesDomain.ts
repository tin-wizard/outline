import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BeforeValidate,
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import PagesSite from "./PagesSite";
import IdModel from "./base/IdModel";

export enum PagesDomainStatus {
  Pending = "pending",
  Verified = "verified",
  Active = "active",
  Failed = "failed",
}

@Table({
  tableName: "pages_domains",
  modelName: "pagesDomain",
  indexes: [{ fields: ["siteId"] }],
})
class PagesDomain extends IdModel<
  InferAttributes<PagesDomain>,
  Partial<InferCreationAttributes<PagesDomain>>
> {
  /** Globally unique, stored lowercase. */
  @Column(DataType.STRING)
  hostname: string;

  /** One of pending, verified or failed. */
  @Default(PagesDomainStatus.Pending)
  @Column(DataType.STRING)
  verificationStatus: PagesDomainStatus;

  /** One of pending, active or failed. */
  @Default(PagesDomainStatus.Pending)
  @Column(DataType.STRING)
  certificateStatus: PagesDomainStatus;

  @Column(DataType.DATE)
  activatedAt: Date | null;

  // hooks

  @BeforeValidate
  static lowercaseHostname(model: PagesDomain) {
    if (model.hostname) {
      model.hostname = model.hostname.toLowerCase();
    }
  }

  // associations

  @BelongsTo(() => PagesSite, "siteId")
  site: PagesSite;

  @ForeignKey(() => PagesSite)
  @Column(DataType.UUID)
  siteId: string;
}

export default PagesDomain;
