import { AssetSummary, BoothAssetInfo, commands, Result } from '@/lib/bindings'
import { AssetFormType } from '@/lib/form'

type Props = {
  boothItemId: number
  form: AssetFormType
  setImageUrls: (imageUrls: string[]) => void
}

type ReturnProps =
  | {
      goNext: true
      duplicated: false
    }
  | {
      goNext: false
      duplicated: true
      duplicatedItems: AssetSummary[]
    }

export const getAndSetAssetInfoFromBoothToForm = async ({
  boothItemId,
  form,
  setImageUrls,
}: Props): Promise<Result<ReturnProps, string>> => {
  const result = await commands.getAssetInfoFromBooth(boothItemId)

  if (result.status === 'error') {
    return result
  }

  const data = result.data

  form.setValue('name', data.name)
  form.setValue('creator', data.creator)
  form.setValue('publishedAt', data.publishedAt)
  form.setValue('boothItemId', boothItemId)
  form.setValue('assetType', data.estimatedAssetType ?? 'Avatar')

  // [custom] タグ・カテゴリ・対応アバターをBooth情報から自動推定する
  // (推定に失敗しても取得処理全体は止めない)
  try {
    await applyCustomAutoFill(data, form)
  } catch (e) {
    console.error('[custom] auto fill failed:', e)
  }

  setImageUrls(data.imageUrls)
  if (data.imageUrls.length > 0) {
    const imageResolveResult = await commands.resolvePximgFilename(
      data.imageUrls[0],
    )

    if (imageResolveResult.status === 'ok') {
      form.setValue('imageFilename', imageResolveResult.data)
    }
  }

  const duplicationCheckResult =
    await commands.getAssetDisplaysByBoothId(boothItemId)

  if (duplicationCheckResult.status === 'ok') {
    const duplicationCheckData = duplicationCheckResult.data

    if (duplicationCheckData.length > 0) {
      return {
        status: 'ok',
        data: {
          goNext: false,
          duplicated: true,
          duplicatedItems: duplicationCheckData,
        },
      }
    }
  }

  if (duplicationCheckResult.status === 'error') {
    return {
      status: 'error',
      error: duplicationCheckResult.error,
    }
  }

  return {
    status: 'ok',
    data: {
      goNext: true,
      duplicated: false,
    },
  }
}

// [custom] Boothの商品名・説明文・タグから、タグ/カテゴリ/対応アバターを推定してフォームに入れる。
// 既にユーザーが値を入れている(編集時など)フィールドには触らない。
const TAG_NOISE = new Set(['vrchat', 'vrc', '3dモデル', '3d model', 'booth'])

const CATEGORY_RULES: [RegExp, string][] = [
  [/ヘアピン|ピアス|イヤリング|チョーカー|ネックレス|指輪|リング|アクセサリ|眼鏡|メガネ|サングラス|ハロー|ヘイロー/i, 'アクセサリ'],
  [/髪型|ヘアスタイル|(?<![ア-ンa-z])ヘア(?!ピン)|hair/i, '髪'],
  [/衣装|(?<!装飾)服|ワンピース|パーカー|ドレス|スカート|コーデ|セットアップ|水着|靴|ブーツ|outfit|costume/i, '衣装'],
  [/テクスチャ|texture|アイテクスチャ|瞳|肌|スキン/i, 'テクスチャ'],
  [/ギミック|システム|ツール|gimmick|システム/i, 'ギミック・ツール'],
  [/ポーズ|アニメーション|モーション|emote/i, 'モーション'],
]

const applyCustomAutoFill = async (
  data: BoothAssetInfo,
  form: AssetFormType,
) => {
  const corpus = (
    data.name +
    '\n' +
    data.description +
    '\n' +
    data.tags.join('\n')
  ).toLowerCase()

  // タグ: Boothの商品タグをそのまま採用(汎用的すぎるものは除外、最大10個)
  if (form.getValues('tags').length === 0) {
    const tags = data.tags
      .filter((tag) => !TAG_NOISE.has(tag.toLowerCase()))
      .slice(0, 10)
    if (tags.length > 0) {
      form.setValue('tags', tags)
    }
  }

  // 対応アバター: 過去に使った対応アバター名が本文に含まれていればセット
  if (form.getValues('supportedAvatars').length === 0) {
    const avatarsResult = await commands.getAvatarWearableSupportedAvatars(null)
    if (avatarsResult.status === 'ok') {
      const matched = avatarsResult.data
        .map((entry) => entry.value)
        .filter(
          (value) =>
            value.length >= 2 && corpus.includes(value.toLowerCase()),
        )
      if (matched.length > 0) {
        form.setValue('supportedAvatars', matched)
      }
    }
  }

  // カテゴリ: 過去に使ったカテゴリ名が本文に含まれていれば優先採用、なければキーワード判定
  if (form.getValues('category') === '') {
    let category = ''

    const categoriesResult = await commands.getAvatarWearableCategories(null)
    if (categoriesResult.status === 'ok') {
      const hits = categoriesResult.data.filter(
        (entry) =>
          entry.value.length >= 2 &&
          corpus.includes(entry.value.toLowerCase()),
      )
      if (hits.length > 0) {
        category = hits.sort((a, b) => b.priority - a.priority)[0].value
      }
    }

    if (category === '') {
      for (const [pattern, value] of CATEGORY_RULES) {
        if (pattern.test(corpus)) {
          category = value
          break
        }
      }
    }

    if (category !== '') {
      form.setValue('category', category)
    }
  }
}
