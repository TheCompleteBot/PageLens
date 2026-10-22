import { useContext, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Card } from "../../components/Card";
import { ProductDetail } from "../../components/ProductDetail";
import { ShoppingCartContext } from "../../Context";

function Home() {
  const { 
    searchValue,
    setSearchValue,
    filteredItems,
    updateCategoryPath
  } = useContext(ShoppingCartContext);
  // The router's path, without the base URL (the app may be hosted under a sub-path).
  const { pathname } = useLocation();

  useEffect(() => {
    updateCategoryPath(pathname);
  }, []);

  return (
    <>
      <div className="mb-4">
        <h1 className="font-medium text-xl">Exclusive Products</h1>
      </div>
      <input 
        value={searchValue}
        type="text" 
        placeholder="Search a product"
        className="rounded-lg border border-black w-80 p-4 mb-4 focus:outline-none"
        onChange={event => setSearchValue(event.target.value)}
      />
      <div className="grid gap-4 grid-cols-4 w-full max-w-screen-lg">
        {filteredItems?.map((item) => (
          <Card key={item.id} data={item} />
        ))}
        {filteredItems.length === 0 && <p>No products</p>}
      </div>
      <ProductDetail />
    </>
  );
}

export { Home };
