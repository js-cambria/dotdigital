class InsightBuilderService {
  buildOrderRecord(order) {
    if (!order || !order.id || !order.currency || !Array.isArray(order.products)) {
      throw new Error("Order requires id, currency, and products[]");
    }

    const products = order.products.map((product) => ({
      name: product.name,
      sku: product.sku,
      qty: Number(product.qty),
      price: Number(product.price)
    }));

    return {
      id: String(order.id),
      order_total: Number(order.orderTotal),
      order_subtotal: Number(order.orderSubtotal),
      currency: order.currency,
      purchase_date: order.purchaseDate,
      products
    };
  }

  buildCatalogProductRecord(product) {
    return {
      id: String(product.id),
      sku: String(product.sku),
      name: product.name,
      url: product.url,
      image_path: product.imagePath,
      price: Number(product.price)
    };
  }

  buildRecordKey(prefix, uniqueValue) {
    return `${prefix}:${uniqueValue}`;
  }
}

module.exports = {
  InsightBuilderService
};
