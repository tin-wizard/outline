import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import PagesSite from "./PagesSite";
import User from "./User";
import IdModel from "./base/IdModel";

export enum PagesSourceType {
  Document = "document",
  Collection = "collection",
}

@Table({
  tableName: "pages_publications",
  modelName: "pagesPublication",
  indexes: [{ fields: ["siteId", "pageKey"], unique: true }],
})
class PagesPublication extends IdModel<
  InferAttributes<PagesPublication>,
  Partial<InferCreationAttributes<PagesPublication>>
> {
  @Column(DataType.STRING)
  sourceType: PagesSourceType;

  @Column(DataType.UUID)
  sourceId: string;

  /** Path of the page within the site, e.g. `index.html`. */
  @Column(DataType.STRING(512))
  pageKey: string;

  @Column(DataType.STRING)
  contentHash: string;

  @Column(DataType.STRING(512))
  objectKey: string;

  /** The page's title at publish time, for Insights; never part of a key. */
  @Column(DataType.STRING(1024))
  title: string | null;

  @Column(DataType.DATE)
  publishedAt: Date;

  // associations

  @BelongsTo(() => PagesSite, "siteId")
  site: PagesSite;

  @ForeignKey(() => PagesSite)
  @Column(DataType.UUID)
  siteId: string;

  @BelongsTo(() => User, "publishedById")
  publishedBy: User | null;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  publishedById: string | null;
}

export default PagesPublication;
