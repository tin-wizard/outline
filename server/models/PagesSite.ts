import crypto from "node:crypto";
import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BeforeCreate,
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  HasMany,
  Table,
} from "sequelize-typescript";
import PagesDomain from "./PagesDomain";
import PagesInsight from "./PagesInsight";
import PagesPublication from "./PagesPublication";
import PagesViewEvent from "./PagesViewEvent";
import Team from "./Team";
import User from "./User";
import IdModel from "./base/IdModel";

export enum PagesSiteStatus {
  Draft = "draft",
  Published = "published",
  Unpublished = "unpublished",
}

@Table({
  tableName: "pages_sites",
  modelName: "pagesSite",
  indexes: [{ fields: ["teamId"] }],
})
class PagesSite extends IdModel<
  InferAttributes<PagesSite>,
  Partial<InferCreationAttributes<PagesSite>>
> {
  @Column(DataType.STRING)
  slug: string;

  @Column(DataType.STRING)
  title: string;

  @Default(PagesSiteStatus.Draft)
  @Column(DataType.STRING)
  status: PagesSiteStatus;

  @Default("code")
  @Column(DataType.STRING)
  gateType: string;

  /** The object storage prefix for the site, e.g. `sites/<slug>/`. */
  @Column(DataType.STRING)
  prefix: string;

  @Default(0)
  @Column(DataType.INTEGER)
  currentVersion: number;

  @Default(0)
  @Column(DataType.INTEGER)
  codeVersion: number;

  @Column(DataType.DATE)
  rotatedAt: Date | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  measurementEnabled: boolean;

  /** Public random identifier embedded in published pages. */
  @Column(DataType.STRING)
  ingestKey: string;

  // hooks

  @BeforeCreate
  static generateIngestKey(model: PagesSite) {
    if (!model.ingestKey) {
      // 16 random bytes encode to 22 url-safe characters.
      model.ingestKey = crypto.randomBytes(16).toString("base64url");
    }
  }

  // associations

  @BelongsTo(() => Team, "teamId")
  team: Team;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;

  @BelongsTo(() => User, "createdById")
  createdBy: User;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  createdById: string;

  @BelongsTo(() => User, "rotatedById")
  rotatedBy: User | null;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  rotatedById: string | null;

  @HasMany(() => PagesPublication, "siteId")
  publications: PagesPublication[];

  @HasMany(() => PagesDomain, "siteId")
  domains: PagesDomain[];

  @HasMany(() => PagesViewEvent, "siteId")
  viewEvents: PagesViewEvent[];

  @HasMany(() => PagesInsight, "siteId")
  insights: PagesInsight[];
}

export default PagesSite;
