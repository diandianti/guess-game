export const  getRandomElement = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) {
      return undefined; // 或者抛出错误，表示输入无效
    }
  
    // 生成一个随机索引
    const randomIndex = Math.floor(Math.random() * arr.length);
  
    // 返回数组中对应随机索引的元素
    return arr[randomIndex];
  }