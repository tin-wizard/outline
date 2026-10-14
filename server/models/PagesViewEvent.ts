import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import PagesSite from "./PagesSite";
import IdModel from "./base/IdModel";

/** One row per page view; heartbeats update the row. */
@Table({
  tableName: "pages_view_events",
  modelName: "pagesViewEvent",
  indexes: [
    {
      fields: ["siteId", "sessionId", "pageKey", "startedAt"],
      unique: true,
    },
    { fields: ["siteId", "startedAt"] },
  ],
})
class PagesViewEvent extends IdModel<
  InferAttributes<PagesViewEvent>,
  Partial<InferCreationAttributes<PagesViewEvent>>
> {
  @Column(DataType.STRING(512))
  pageKey: string;

  @Column(DataType.STRING)
  sessionId: string;

  @Column(DataType.DATE)
  startedAt: Date;

  @Column(DataType.DATE)
  lastSeenAt: Date;

  @Default(0)
  @Column(DataType.INTEGER)
  activeSeconds: number;

  @Column(DataType.STRING)
  referrerDomain: string | null;

  @Column(DataType.STRING(2))
  country: string | null;

  // associations

  @BelongsTo(() => PagesSite, "siteId")
  site: PagesSite;

  @ForeignKey(() => PagesSite)
  @Column(DataType.UUID)
  siteId: string;
}

export default PagesViewEvent;
